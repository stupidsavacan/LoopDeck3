import { expect } from '@playwright/test';

export const reportedPrompt = '第一次世界大戦後、イギリスが1919年インド統治法で部分的な自治しか認めず、インドの民族運動を弾圧するために用いた強圧的な法令（1919年）を何というか。';
const longJapanese = '長い日本語の文章を最後まで読めることを確認します。'.repeat(24) + '\n末尾の確認';
const pairs = [
  ['reported', reportedPrompt, 'ローラット法'],
  ['ninety', 'あ'.repeat(90), 'あ'.repeat(91)],
  ['short', 'strict', '厳しい'],
  ['front-long', longJapanese, '短い答え'],
  ['both-long', longJapanese, longJapanese],
  ['english', 'UnbrokenEnglishToken'.repeat(50), 'English sentence with spaces. '.repeat(40)],
  ['lines', '改行を含む文章\n'.repeat(30), '最初の行\n\n最後の行'],
  ['extras', reportedPrompt, '短い答え']
];
export const overflowPack = {
  packVersion: 1, packId: 'overflow-qa', title: 'カード表示確認', folders: [],
  modules: [{ id: 'overflow-qa', title: 'カード表示確認', questionIds: pairs.map(([id]) => id) }],
  questions: pairs.map(([id, prompt, answer]) => ({ id, moduleId: 'overflow-qa', type: 'input', prompt, answer,
    ...(id === 'extras' ? { imageAsset: 'assets/test.png', explanation: longJapanese, example: longJapanese,
      visualReferences: [{ type: 'color', color: '#EDB0AA', label: '資料' }] } : {}) }))
};

export async function startOverflowSession(page, url) {
  await page.goto(url);
  await expect(page.locator('.home-screen')).toBeVisible();
  await page.evaluate(async pack => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('loopdeck3-learning');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160;
    canvas.getContext('2d').fillRect(0, 0, 240, 160);
    await new Promise((resolve, reject) => {
      const tx = database.transaction(['packs', 'packAssets'], 'readwrite');
      tx.objectStore('packs').put(pack);
      tx.objectStore('packAssets').put({ assetId: JSON.stringify([pack.packId, 'assets/test.png']), packId: pack.packId,
        path: 'assets/test.png', mimeType: 'image/png', dataUrl: canvas.toDataURL() });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    database.close();
  }, overflowPack);
  await page.goto(`${url}#module/overflow-qa`);
  await page.reload();
  await expect(page.locator('.module-screen')).toBeVisible();
  await page.locator('.v2-customize > summary').click();
  await page.getByLabel('シャッフル', { exact: false }).uncheck();
  await page.getByLabel('回答形式').selectOption('flashcard');
  await page.getByLabel('出題形式').selectOption('as_stored');
  await page.getByLabel('例文', { exact: false }).check();
  await page.getByRole('button', { name: '学習を始める', exact: true }).click();
  await settleCard(page);
}

export async function settleCard(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    let idleFrames = 0;
    while (idleFrames < 4) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const animations = [...document.querySelectorAll('.flashcard-wrap, .flashcard-inner')].flatMap(node => node.getAnimations());
      idleFrames = animations.length ? 0 : idleFrames + 1;
      await Promise.allSettled(animations.map(animation => animation.finished));
    }
  });
}

export async function measureFace(page, side) {
  return page.locator(`.flashcard-${side} .flashcard-content`).evaluate(content => {
    const term = content.querySelector('.flashcard-term');
    const children = [...content.children];
    const first = children[0].getBoundingClientRect(), last = children.at(-1).getBoundingClientRect();
    const viewport = content.getBoundingClientRect();
    return { font: parseFloat(getComputedStyle(term).fontSize), height: content.clientHeight,
      scrollHeight: content.scrollHeight, scrollTop: content.scrollTop, width: content.clientWidth,
      scrollWidth: content.scrollWidth, firstVisible: first.top >= viewport.top - 1,
      lastVisible: last.bottom <= viewport.bottom + 1, whiteSpace: getComputedStyle(term).whiteSpace };
  });
}

export async function dragTouch(page, locator, dx, dy) {
  await locator.scrollIntoViewIfNeeded();
  await settleCard(page);
  const bounds = await locator.boundingBox();
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height * (dy < 0 ? 0.8 : 0.5);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    if (dx || dy) {
      for (let step = 1; step <= 10; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10 }] });
        await page.waitForTimeout(20);
      }
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  // A new gesture during native momentum scrolling can merely stop the fling.
  // Wait for the visible/hidden scroll positions before flipping or replacing a card.
  await page.evaluate(() => new Promise(resolve => {
    let previous = '', stable = 0;
    const sample = () => {
      const current = [...document.querySelectorAll('.flashcard-content')].map(node => node.scrollTop).join(',');
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 5) resolve();
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}

export async function checkTouchScroll(page, side) {
  const other = side === 'front' ? 'back' : 'front';
  const content = page.locator(`.flashcard-${side} .flashcard-content`);
  const hidden = page.locator(`.flashcard-${other} .flashcard-content`);
  const hiddenTop = await hidden.evaluate(node => node.scrollTop);
  const position = await page.locator('.flashcard-position').textContent();
  const counts = await page.locator('.flashcard-counts').textContent();
  await content.evaluate(node => { node.scrollTop = 0; });
  for (let step = 0; step < 30; step++) {
    const before = await measureFace(page, side);
    if (before.lastVisible) break;
    await dragTouch(page, content, 0, -Math.min(160, before.height * 0.6));
    const diagnostic = { side, position, before, after: await measureFace(page, side), hidden: await measureFace(page, other) };
    await expect.poll(() => content.evaluate(node => node.scrollTop), { message: JSON.stringify(diagnostic) }).toBeGreaterThan(before.scrollTop);
  }
  const end = await measureFace(page, side);
  expect(end.lastVisible).toBe(true);
  expect(await hidden.evaluate(node => node.scrollTop)).toBe(hiddenTop);
  await expect(page.locator('.flashcard-position')).toHaveText(position);
  await expect(page.locator('.flashcard-counts')).toHaveText(counts);
  await expect(page.locator(`.flashcard-${side}`)).toHaveAttribute('aria-hidden', 'false');
  return end;
}

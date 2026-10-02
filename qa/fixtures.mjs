export const longText = '長い日本語教材名・確認用１２３ / ABC🙂 é\n' + 'UnbrokenEnglishToken'.repeat(16);
export function fixture() {
  const folders = Array.from({ length: 12 }, (_, i) => ({ id: `qa-folder-${i}`, title: `${i} ${longText}` }));
  const modules = Array.from({ length: 48 }, (_, i) => ({ id: `qa-module-${i}`, folderId: folders[i % 12].id, title: `${i} ${longText}`, subject: 'QA', description: longText, questionIds: Array.from({ length: 12 }, (_, j) => `qa-q-${i}-${j}`) }));
  const questions = modules.flatMap((m) => m.questionIds.map((id, j) => ({
    id, moduleId: m.id, type: j % 3 === 0 ? 'input' : j % 3 === 1 ? 'choice' : 'multi_select',
    prompt: `${j} ${longText}`, explanation: longText.repeat(3), number: j + 1,
    ...(j % 3 === 2 ? { correctChoices: ['一'], choices: ['一', '二', '三', '四'] } : { answer: 'answer', ...(j % 3 === 1 ? { choices: ['answer', ...[1, 2, 3].map(n => `${n}${longText}`)] } : {}) }),
    ...(j >= 3 ? { imageAsset: `assets/image-${j}.png` } : {}),
  })));
  const pack = { packVersion: 1, packId: 'qa-hostile', title: longText, folders, modules, questions };
  const now = new Date().toISOString();
  const attempts = Array.from({ length: 3000 }, (_, i) => {
    const q = questions[i % questions.length];
    return { attemptId: `qa-attempt-${i}`, questionId: q.id, moduleId: q.moduleId, answeredAt: new Date(Date.now() - i * 3600000).toISOString(), result: i % 2 ? 'correct' : 'wrong', input: 'x', answer: 'answer', elapsedMs: 1000, mode: 'normal' };
  });
  const reviewCards = questions.map(q => ({ questionId: q.id, moduleId: q.moduleId, state: 'review', dueAt: now, lastReviewedAt: now, firstReviewedAt: now, intervalDays: 1, ease: 2.5, totalReviews: 5, totalCorrect: 2, totalWrong: 3, correctStreak: 0, wrongStreak: 1, lapseCount: 1, leechLevel: 0, suspended: false, createdAt: now, updatedAt: now }));
  return { packs: [pack], attempts, reviewCards, bookmarks: questions.map(q => ({ questionId: q.id, createdAt: now })) };
}

// Seed only the isolated browser context's real stores; no production test hooks.
export async function seed(page, volume = true) {
  const data = fixture();
  if (!volume) { data.attempts = []; data.reviewCards = []; data.bookmarks = []; }
  await page.evaluate(async ({ data, longText }) => {
    const database = await new Promise((resolve, reject) => {
      // Open the database at its existing version so QA follows production schema upgrades.
      const r = indexedDB.open('loopdeck3-db'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const assets = [];
    const dimensions = [[2400, 120], [120, 2400], [512, 512], [4096, 4096], [8, 8], [1000, 700]];
    dimensions.forEach(([width, height], i) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#dceaff'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#123'; ctx.font = '20px sans-serif';
      for (let y = 20; y < height; y += 30) ctx.fillText('Dense labels 日本語 123 '.repeat(20), 0, y);
      const path = `assets/image-${i + 3}.png`;
      assets.push({ assetId: `qa-hostile:${path}`, packId: 'qa-hostile', path, mimeType: 'image/png', dataUrl: canvas.toDataURL() });
    });
    data.packAssets = assets; // 9–11 intentionally missing, shared by many questions.
    await new Promise((resolve, reject) => {
      const tx = database.transaction(Object.keys(data), 'readwrite');
      for (const [store, rows] of Object.entries(data)) { tx.objectStore(store).clear(); for (const row of rows) tx.objectStore(store).put(row); }
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    database.close();
    localStorage.setItem('loopdeck3_debug_logs_v1', JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: `qa-${i}`, timestamp: new Date().toISOString(), level: 'info', area: 'qa-fixture', detail: longText.repeat(2) }))));
  }, { data, longText });
}

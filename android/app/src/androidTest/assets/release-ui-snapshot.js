(async () => {
  try {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('loopdeck3-learning');
      request.onsuccess = () => resolve(request.result);
      request.onerror = reject;
    });
    const names = ['packs', 'packAssets', 'packSync', 'cloudOutbox', 'attempts', 'bookmarks', 'reviewCards', 'reviewLogs', 'cloudConfig'];
    const tx = db.transaction(names);
    const requests = Object.fromEntries(names.map(name => [name, tx.objectStore(name).getAll()]));
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; });
    db.close();
    const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const learning = {};
    for (const name of ['attempts', 'bookmarks', 'reviewCards', 'reviewLogs']) {
      learning[name] = {count: requests[name].result.length, sha256: await digest(requests[name].result)};
    }
    const packs = {};
    for (const pack of requests.packs.result) packs[pack.packId] = await digest(pack);
    const target = requests.packs.result.find(pack => pack.packId === window.__releaseQaTarget);
    const builtin = requests.packs.result.find(pack => pack.packId === 'loopdeck-builtin-v1');
    const config = requests.cloudConfig.result.find(row => row.key === 'settings');
    window.__releaseQaSnapshot = {
      learning, packs,
      outboxCount: requests.cloudOutbox.result.length,
      states: requests.packSync.result,
      setupComplete: !!config?.setupComplete,
      nativeTokenReference: config?.token === '@android-keystore',
      builtinQuestions: builtin?.questions.length ?? 0,
      builtinImages: requests.packAssets.result.filter(asset => asset.packId === 'loopdeck-builtin-v1').length,
      targetPresent: !!target,
      targetAnswer: target?.questions[0]?.answer ?? null,
      status: document.querySelector('.cloud-sync-icon')?.dataset.status
    };
  } catch (_) {
    window.__releaseQaSnapshot = {qaError: true};
  }
})();

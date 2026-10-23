import {setTimeout as delay} from 'node:timers/promises';

// Do not pass an async predicate to Playwright 1.63 waitForFunction: its
// injected poller treats the Promise itself as truthy and may resolve false.
export async function pollPage(page,predicate,arg,options={}) {
  const deadline=Date.now()+(options.timeout??90000);
  while(Date.now()<deadline){
    if(await page.evaluate(predicate,arg))return;
    await delay(250);
  }
  throw new Error('Async page predicate did not become true before timeout.');
}

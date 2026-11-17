import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [mode, directory, port = '8098'] = process.argv.slice(2);
assert(['demo', 'connected'].includes(mode) && directory, 'Run pnpm test:ui demo|connected EXPORT_DIRECTORY [PORT]');
const root = resolve(directory);
const index = join(root, 'index.html');
await stat(index);
const ramen = fileURLToPath(new URL('../assets/food/ramen.jpg', import.meta.url));
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.ttf': 'font/ttf',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = resolve(root, '.' + requestPath);
    if (!file.startsWith(root + sep) || !(await stat(file).catch(() => null))?.isFile()) {
      if (extname(requestPath)) return res.writeHead(404).end();
      file = index;
    }
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch {
    res.writeHead(400).end();
  }
});

async function exercise(page) {
  const button = name => page.getByRole('button', { name, exact: true });
  const tab = name => page.getByRole('tab', { name, exact: true });
  const field = name => page.getByRole('textbox', { name, exact: true });
  const visibleText = name => page.getByText(name, { exact: true }).filter({ visible: true });
  const heading = name => page.getByRole('heading', { name, exact: true });
  const photo = async () => {
    const selected = page.waitForEvent('filechooser');
    await button('Add a photo or clip').click();
    await (await selected).setFiles(ramen);
    await button('Remove attachment').waitFor();
  };

  await page.goto('http://127.0.0.1:' + server.address().port);
  await heading('Discover').waitFor();
  if (mode === 'demo') {
    await button('Save Miso House').first().click();
    await button('Remove Miso House from saved').first().waitFor();
    await tab('Saved').click();
    await button('View Miso House').waitFor();
    await tab('Explore').click();
    await button('Help me choose').click();
    await field('What are you looking for?').fill('Vegetarian ramen in the East Village');
    await button('Find suggestions').click();
    await button('View Miso House').waitFor();
    await button('Edit filters').click();
    assert.equal(await field('Neighborhood or city').inputValue(), 'East Village');
    await button('Search with these filters').click();
    await button('View Miso House').waitFor();
    assert.equal(await field('Restaurant, dish, or neighborhood').inputValue(), 'ramen');
    await page.getByRole('button', { name: /Read the source review/ }).first().click();
    await button('Find this dish').click();
    assert.match(await field('Restaurant, dish, or neighborhood').inputValue(), /miso ramen/i);
    console.log('Saved restaurant, editable dining suggestions, dish evidence, and return to Explore');

    await tab('Discover').click();
    await tab('Clips').click();
    await button('Play clip').click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some(video => video.currentTime > 0.18 && !video.paused));
    await button('Pause playback').click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some(video => video.paused));
    await button('Read full review').click();
    await visibleText('A closer look at the bowl I keep thinking about.').waitFor();
    await button('Back').click();
    await page.getByLabel('Log a visit', { exact: true }).click();
    await button('View Miso House').click();
    await tab('Public review').click();
    await field('What did you order?').fill('Black garlic noodles');
    await field('Your review').fill('A delightful lunch with an outstanding bowl of ramen.');
    assert.equal(await button('Post review').isDisabled(), true);
    await field('Your score out of 10').fill('9.3');
    await photo();
    await button('Post review').click();
    await button('Compare with a past visit').click();
    await page.getByRole('button', { name: /Bar Farina/ }).click();
    await button('Prefer Miso House').click();
    await visibleText('Your rankings were updated').waitFor();
    console.log('Reduced-motion clip controls, deliberate photo review, and post-to-compare flow');

    await button('Back').click();
    await page.getByLabel('Log a visit', { exact: true }).click();
    await button('View Santo Taco').click();
    await field('Dishes').fill('Al pastor and salsa verde');
    await field('Private note').fill('Private memory for another lunch.');
    await button('Save private visit').click();
    await visibleText('Private memory for another lunch.').waitFor();
    await button('Edit private memory').click();
    await field('Private note').fill('Private memory with the table by the window.');
    await button('Save memory changes').click();
    await visibleText('Private memory with the table by the window.').waitFor();
    await button('Back').click();
    await tab('Saved').click();
    await tab('Journal').click();
    await visibleText('Private memory with the table by the window.').waitFor();
    console.log('Private meal with optional score, editing, and journal history');
    await tab('You').click();
    await button('Restaurant tools').click();
    await button('View Soft Butter').click();
    await button('Edit listing details').click();
    await field('Hours').fill('Mon–Sun 8 AM–4 PM');
    await field('Menu link').fill('https://example.test/menu');
    await button('Set weekly hours and exceptions').click();
    await field('Restaurant timezone').fill('America/New_York');
    for (const day of ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']) await field(day + ' hours').fill('00:00-24:00');
    await field('Date exceptions').fill('2026-12-25 Closed');
    await field('Preview date').fill('2026-12-25');
    await button('Preview diner hours').click();
    await visibleText('Closed · America/New_York').waitFor();
    await button('Publish listing updates').click();
    await tab('Needs a response').click();
    await button('Respond to review').click();
    await button('Reply as restaurant').click();
    await button('Suggest a reply').click();
    await visibleText('Suggested draft').waitFor();
    assert.equal(await button('Publish response').isDisabled(), true);
    await button('Use draft').click();
    assert.ok((await field('Public restaurant response').inputValue()).length > 0);
    const reply = 'Thanks for visiting. The brioche is baked here every morning.';
    await field('Public restaurant response').fill(reply);
    await button('Publish response').click();
    await visibleText(reply).waitFor();
    await button('Back').click();
    await button('View listing').click();
    await visibleText('Sun 00:00–24:00').waitFor();
    await page.reload();
    await visibleText('Sun 00:00–24:00').waitFor();
    console.log('Owner inbox, editable reply suggestion, published response, and persisted hours');
    return;
  }

  const api = new URL(process.env.GOODFORK_TEST_API_URL);
  const database = new URL(process.env.GOODFORK_TEST_DATABASE_URL);
  const { GOODFORK_TEST_BINARY: binary, GOODFORK_TEST_MAIL_LOG: mailLog } = process.env;
  assert(api.protocol === 'http:' && api.hostname === '127.0.0.1' &&
    ['postgres:', 'postgresql:'].includes(database.protocol) &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname), 'Connected tests use a disposable loopback setup');
  assert(binary && mailLog, 'Set GOODFORK_TEST_BINARY and GOODFORK_TEST_MAIL_LOG for the local backend');
  await page.route('**/v1/**', route => new URL(route.request().url()).origin === api.origin ? route.continue() : route.abort());
  const email = 'ui_' + Date.now().toString(36) + '@example.test';
  const password = 'a temporary test password 42';
  const priorSize = (await stat(mailLog)).size;
  await tab('You').click();
  await button('Sign in or join').click();
  await tab('Join Goodfork').click();
  await field('Display name').fill('Browser QA');
  await field('Email').fill(email);
  await field('Public handle').fill(email.split('@')[0]);
  await field('Password').fill(password);
  await page.getByRole('checkbox').click();
  await button('Create account').click();
  await visibleText('Check your inbox').waitFor();
  let code;
  const mailDeadline = Date.now() + 3000;
  while (!code && Date.now() < mailDeadline) {
    const completeLines = (await readFile(mailLog)).subarray(priorSize).toString().split('\n').slice(0, -1);
    for (const line of completeLines) {
      try {
        const row = JSON.parse(line);
        if (row.msg === 'local email verification') code = row.code;
      } catch { /* Wait for a complete fixture log entry. */ }
    }
    if (!code) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(typeof code === 'string' && /^\d{8}$/.test(code),
    'The fixture verification code was not found. Set GOODFORK_TEST_MAIL_LOG to the running API mail log.');
  await field('Verification code').fill(code);
  await button('Verify email').click();
  await visibleText('Save your recovery code').waitFor();
  await button('Continue to Goodfork').click();
  await heading('Browser QA').waitFor();
  console.log('Connected email signup and verification');

  await page.getByLabel('Log a visit', { exact: true }).click();
  await button('View Sample Ramen Counter').click();
  await tab('Public review').click();
  const dish = 'Black garlic miso ramen';
  const reviewText = 'Ramen worth visiting again. The miso was excellent.';
  await field('Your score out of 10').fill('9.3');
  await field('What did you order?').fill(dish);
  await field('Your review').fill(reviewText);
  await photo();
  const posted = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === api.origin + '/v1/posts');
  await button('Post review').click();
  const response = await posted;
  assert.equal(response.status(), 201, 'The Go API accepted the photo review');
  const post = await response.json();
  await visibleText('Awaiting moderation').waitFor();
  await page.waitForFunction(() => Array.from(document.images).some(image => image.alt === 'Black garlic miso ramen' && image.complete && image.naturalWidth > 0));
  execFileSync(binary, ['moderate', 'publish-post', post.id, post.revision], {
    env: { ...process.env, APP_ENV: 'local', DATABASE_URL: database.href },
  });
  await page.reload();
  await visibleText(reviewText).waitFor();
  await button('Like review, 0').click();
  await button('Unlike review, 1').waitFor();
  let changedReview = false;
  await page.route(api.origin + '/v1/posts/' + post.id, async route => {
    if (route.request().method() === 'PATCH' && !changedReview) {
      changedReview = true;
      const payload = route.request().postDataJSON();
      const concurrent = await route.fetch({ postData: { ...payload, text: 'A concurrent test review update.' } });
      assert.equal(concurrent.status(), 200);
    }
    await route.continue();
  });
  await button('Edit review').click();
  await field('Your review').fill('My review draft remains available after a conflict.');
  await button('Save changes').click();
  await button('Load current review').click();
  await visibleText('A concurrent test review update.').waitFor();
  assert.equal(await field('Your review').inputValue(), 'My review draft remains available after a conflict.');
  await button('Keep my review draft').click();
  await button('Save changes').click();
  await visibleText('My review draft remains available after a conflict.').waitFor();

  let releaseComment;
  let markCommitted;
  const heldComment = new Promise(resolve => { releaseComment = resolve; });
  const commentCommitted = new Promise(resolve => { markCommitted = resolve; });
  let delayComment = true;
  let loseComment = true;
  await page.route(api.origin + '/v1/posts/' + post.id + '/comments', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const result = await route.fetch();
    if (delayComment) {
      delayComment = false;
      markCommitted();
      await heldComment;
      return route.fulfill({ response: result });
    }
    if (loseComment) { loseComment = false; return route.abort(); }
    return route.fulfill({ response: result });
  });
  await field('Add a comment').fill('A first posted comment.');
  await button('Post').click();
  await commentCommitted;
  await field('Add a comment').fill('A second draft typed during submission.');
  releaseComment();
  await visibleText('A first posted comment.').waitFor();
  assert.equal(await field('Add a comment').inputValue(), 'A second draft typed during submission.');
  await button('Post').click();
  await button('Retry comment').waitFor();
  await field('Add a comment').fill('A third draft kept during retry.');
  await button('Retry comment').click();
  await visibleText('A second draft typed during submission.').waitFor();
  assert.equal(await field('Add a comment').inputValue(), 'A third draft kept during retry.');
  assert.equal(await visibleText('A second draft typed during submission.').count(), 1);
  console.log('Connected stale review recovery, preserved comment typing, and response-loss retry');

  await button('Find this dish').click();
  await button('View Sample Ramen Counter').waitFor();
  console.log('Connected private photo, revision-scoped moderation, reactions, and dish search');

  await page.getByLabel('Log a visit', { exact: true }).click();
  await button('View Sample Ramen Counter').click();
  let releaseVisit;
  const visitReleased = new Promise(resolve => { releaseVisit = resolve; });
  let visitCommitted;
  const committedVisit = new Promise(resolve => { visitCommitted = resolve; });
  let delayVisit = true;
  await page.route(api.origin + '/v1/me/visits', async route => {
    if (route.request().method() !== 'POST' || !delayVisit) return route.continue();
    delayVisit = false;
    const result = await route.fetch();
    visitCommitted();
    await visitReleased;
    return route.fulfill({ response: result });
  });
  await field('Private note').fill('A separate connected private lunch memory.');
  await button('Save private visit').click();
  await committedVisit;
  await field('Private note').fill('New typing retained during the first save.');
  releaseVisit();
  await button('Save memory changes').waitFor();
  assert.equal(await field('Private note').inputValue(), 'New typing retained during the first save.');
  await button('Save memory changes').click();
  await visibleText('New typing retained during the first save.').waitFor();
  await button('Edit private memory').click();
  await field('Private note').fill('A separate connected private lunch memory.');
  await button('Save memory changes').click();
  await visibleText('A separate connected private lunch memory.').waitFor();
  await button('Edit private memory').click();
  await field('Private note').fill('A private memory edited through the API.');
  await button('Save memory changes').click();
  await visibleText('A private memory edited through the API.').waitFor();
  await page.reload();
  await visibleText('A private memory edited through the API.').waitFor();
  await button('Back').click();
  await tab('Explore').click();
  if (await button('Clear search').count()) await button('Clear search').click();
  await button('View Sample Pizza Bar').click();
  await button('Claim this restaurant').click();
  await field('Business email').fill('owner@example.test');
  await button('General manager').click();
  const claimed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/claim'));
  await button('Submit claim').click();
  const claim = await (await claimed).json();
  await visibleText('Verification pending').waitFor();
  await button('Back').click();
  await button('Back').click();
  await tab('You').click();
  execFileSync(binary, ['moderate', 'approve-claim', claim.id, String(claim.revision)], {
    env: { ...process.env, APP_ENV: 'local', DATABASE_URL: database.href },
  });
  await button('Restaurant tools').click();
  await button('View Sample Pizza Bar').click();
  await button('Edit listing details').click();
  await field('Hours').fill('Mon–Sun 8 AM–4 PM');
  const listing = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith('/listing'));
  let listingRace = true;
  await page.route('**/v1/places/*/listing', async route => {
    if (route.request().method() === 'PATCH' && listingRace) {
      listingRace = false;
      const details = route.request().postDataJSON();
      const concurrent = await route.fetch({ postData: { ...details, hours: [], phone: '+1 212 555 0101' } });
      assert.equal(concurrent.status(), 200);
    }
    return route.continue();
  });
  await button('Publish listing updates').click();
  assert.equal((await listing).status(), 409);
  await button('Load current listing').click();
  await visibleText('+1 212 555 0101').waitFor();
  await button('Keep my draft').click();
  assert.equal(await field('Phone').inputValue(), '+1 212 555 0101');
  assert.equal(await field('Hours').inputValue(), 'Mon–Sun 8 AM–4 PM');
  await button('Set weekly hours and exceptions').click();
  await field('Restaurant timezone').fill('America/New_York');
  for (const day of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) await field(day + ' hours').fill('00:00-24:00');
  await button('Preview diner hours').click();
  await visibleText('Open · America/New_York').waitFor();
  await button('Publish listing updates').click();
  await button('View listing').click();
  await visibleText('Open now').waitFor();
  await button('Back').click();
  await button('Back').click();
  await button('Back').click();
  await tab('Explore').click();
  await button('Filters').click();
  await button('Open now').click();
  await button('Show results').click();
  await button('View Sample Pizza Bar').waitFor();
  assert.equal(await button('View Sample Ramen Counter').count(), 0);
  console.log('Connected owner conflict merge, structured hours, diner status, and open-now filter');
  await tab('You').click();
  await button('Settings').click();
  await page.route('**/v1/auth/session', route => route.abort());
  await button('Sign out').click();
  await heading('You').waitFor();
  await button('Sign in or join').click();
  await field('Email').fill(email);
  await field('Password').fill(password);
  await button('Sign in').click();
  await heading('Browser QA').waitFor();
  console.log('Connected claim submitted, local sign-out with offline API, and password sign-in');
}

server.listen(Number(port), '127.0.0.1');
await once(server, 'listening');
let browser;
let page;
const errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.GOODFORK_CHROMIUM_EXECUTABLE });
  page = await browser.newPage({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await exercise(page);
  assert.deepEqual(errors, []);
} catch (error) {
  const screenshot = join(tmpdir(), 'goodfork-' + mode + '-failure-' + process.pid + '.png');
  if (mode === 'demo' && page) {
    await page.screenshot({ path: screenshot });
    console.error('Demo failure screenshot:', screenshot);
  }
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } finally { server.close(); }
}

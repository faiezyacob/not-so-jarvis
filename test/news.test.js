/* ============================================
   JARVIS — News service unit tests
   Pure, deterministic helpers only (no network).
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const news = require('../services/news');

// --- stripHtml / decodeEntities ---------------------------------------------

test('stripHtml: removes tags and decodes entities', () => {
    assert.equal(news.stripHtml('<p>Hello <b>world</b> &amp; friends</p>'), 'Hello world & friends');
    assert.equal(news.stripHtml('<![CDATA[<p>Raw &amp; wrapped</p>]]>'), 'Raw & wrapped');
    assert.equal(news.stripHtml('   spaced   out   '), 'spaced out');
});

test('decodeEntities: handles numeric and hex references', () => {
    assert.equal(news.decodeEntities('caf&#233; &#x2014; yes'), 'café \u2014 yes');
});

// --- parseFeed ---------------------------------------------------------------

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>Example</title>
<item>
  <title><![CDATA[Big &amp; Bold News]]></title>
  <link>https://example.com/a</link>
  <description><![CDATA[<p>Something <b>happened</b> today.</p>]]></description>
  <pubDate>Mon, 08 Sep 2025 12:00:00 GMT</pubDate>
  <source>Example Wire</source>
</item>
<item>
  <title><![CDATA[Old story - Example Wire]]></title>
  <link>https://example.com/b</link>
  <source>Example Wire</source>
</item>
<item>
  <title>Missing link item</title>
</item>
</channel></rss>`;

test('parseFeed: reads RSS items and drops entries without a link', () => {
    const items = news.parseFeed(RSS_SAMPLE, { label: 'Example' });
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Big & Bold News');
    assert.equal(items[0].link, 'https://example.com/a');
    assert.equal(items[0].summary, 'Something happened today.');
    assert.equal(items[0].source, 'Example Wire');
    assert.equal(items[0].published, '2025-09-08T12:00:00.000Z');
});

test('parseFeed: strips a trailing " - Source" from the title', () => {
    const items = news.parseFeed(RSS_SAMPLE, { label: 'Example' });
    assert.equal(items[1].title, 'Old story');
});

test('parseFeed: drops items whose link is not http(s)', () => {
    const xml = `<rss><channel><item>
        <title>Bad</title>
        <link>javascript:alert(1)</link>
    </item></channel></rss>`;
    assert.equal(news.parseFeed(xml, {}).length, 0);
});

test('safeLink: allows http(s) and rejects other schemes', () => {
    assert.equal(news.safeLink('https://example.com/a'), 'https://example.com/a');
    assert.equal(news.safeLink('javascript:alert(1)'), '');
    assert.equal(news.safeLink('data:text/html,x'), '');
    assert.equal(news.safeLink('not a url'), '');
});

test('parseFeed: reads Atom entries and href links', () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <title>Atom Title</title>
  <link href="https://atom.example/x"/>
  <updated>2025-09-08T10:00:00Z</updated>
  <summary>Atom summary text</summary>
</entry>
</feed>`;
    const items = news.parseFeed(atom, { label: 'Atom Feed' });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Atom Title');
    assert.equal(items[0].link, 'https://atom.example/x');
    assert.equal(items[0].summary, 'Atom summary text');
    assert.equal(items[0].source, 'Atom Feed');
});

// --- isNewsQuery -------------------------------------------------------------

test('isNewsQuery: matches news questions', () => {
    assert.equal(news.isNewsQuery("what's the news today?"), true);
    assert.equal(news.isNewsQuery('any news about AI regulation?'), true);
    assert.equal(news.isNewsQuery('show me the latest headlines'), true);
    assert.equal(news.isNewsQuery("what's happening in the world?"), true);
});

test('isNewsQuery: ignores unrelated messages', () => {
    assert.equal(news.isNewsQuery('generate an image of a newspaper'), false);
    assert.equal(news.isNewsQuery('tell me a joke'), false);
    assert.equal(news.isNewsQuery('what is the weather like?'), false);
    assert.equal(news.isNewsQuery(''), false);
});

// --- extractTopic ------------------------------------------------------------

test('extractTopic: pulls a topic out of a news question', () => {
    assert.equal(news.extractTopic("what's the news about AI regulation?"), 'AI regulation');
    assert.equal(news.extractTopic('any news on the election'), 'election');
    assert.equal(news.extractTopic('show me the latest on Tesla'), 'Tesla');
    assert.equal(news.extractTopic("what's happening with the Fed"), 'Fed');
});

test('extractTopic: general requests yield no topic', () => {
    assert.equal(news.extractTopic("what's the news?"), '');
    assert.equal(news.extractTopic('latest headlines'), '');
    assert.equal(news.extractTopic('top stories'), '');
    assert.equal(news.extractTopic('what is happening?'), '');
});

test('extractTopic: local/global qualifiers are stripped', () => {
    assert.equal(news.extractTopic("what's the local news?"), '');
    assert.equal(news.extractTopic('local news about the mayor'), 'mayor');
    assert.equal(news.extractTopic('world news about climate'), 'climate');
});

// --- newsScope ---------------------------------------------------------------

test('newsScope: detects local, global, and general requests', () => {
    assert.equal(news.newsScope("what's the local news?"), 'local');
    assert.equal(news.newsScope('news near me'), 'local');
    assert.equal(news.newsScope('world news today'), 'global');
    assert.equal(news.newsScope('international headlines'), 'global');
    assert.equal(news.newsScope("what's the news about AI?"), 'all');
});

// --- resolveFeeds ------------------------------------------------------------

test('resolveFeeds: local scope needs a saved area', () => {
    assert.deepEqual(news.resolveFeeds('local', '', ''), []);
    const scoped = news.resolveFeeds('local', '', 'Portland, OR');
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].category, 'local');
    assert.match(scoped[0].url, /Portland/);
});

test('resolveFeeds: a topic builds a global Google News search', () => {
    const feeds = news.resolveFeeds('global', 'AI regulation', '');
    assert.equal(feeds.length, 1);
    assert.equal(feeds[0].category, 'global');
    assert.match(feeds[0].url, /AI%20regulation/);
});

test('resolveFeeds: local scope with a topic searches the area plus topic', () => {
    const feeds = news.resolveFeeds('local', 'the mayor', 'Springfield');
    assert.equal(feeds.length, 1);
    assert.match(feeds[0].url, /Springfield%20the%20mayor/);
});

// --- formatNews --------------------------------------------------------------

test('formatNews: renders headlines with source and link', () => {
    const text = news.formatNews({
        topic: 'AI',
        items: [{ title: 'A headline', source: 'Wire', link: 'https://ex/a', published: '2025-09-08T12:00:00.000Z', summary: 'A summary' }]
    });
    assert.match(text, /A headline/);
    assert.match(text, /Wire/);
    assert.match(text, /https:\/\/ex\/a/);
    assert.match(text, /A summary/);
});

test('formatNews: empty when there are no items', () => {
    assert.equal(news.formatNews({ items: [] }), '');
    assert.equal(news.formatNews(null), '');
});

// --- clampLimit --------------------------------------------------------------

test('clampLimit: bounds the requested item count', () => {
    assert.equal(news.clampLimit(undefined), 10);
    assert.equal(news.clampLimit(5), 5);
    assert.equal(news.clampLimit(999), 25);
    assert.equal(news.clampLimit(0), 10);
});

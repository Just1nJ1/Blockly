/**
 * Shared parsing for extension "depends" entries.
 * Loaded as a page script and required from the Electron main process.
 *
 *   "depends": ["camera"]
 *   "depends": [{ "name": "camera", "url": "https://github.com/org/repo.git" }]
 */
function parseDependEntries(raw) {
  if (raw == null) return [];
  if (typeof raw === 'string') raw = [raw];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    raw = raw.extensions || [];
  }
  if (!Array.isArray(raw)) return [];
  var out = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i];
    var name = '';
    var url = '';
    var displayName = '';
    if (typeof item === 'string') {
      name = item.trim();
    } else if (item && typeof item === 'object') {
      name = String(item.name || item.extension || '').trim();
      url = String(item.url || item.source || '').trim();
      displayName = String(item.displayName || item.display_name || '').trim();
    }
    if (!name || seen[name]) continue;
    seen[name] = true;
    out.push({
      name: name,
      url: url,
      displayName: displayName || name,
    });
  }
  return out;
}

/**
 * GitHub repository URL -> zip of the main branch.
 * A URL that already ends in .zip is returned unchanged.
 * Returns '' when the link is not a GitHub repo or a zip file.
 */
function githubMainZipUrl(sourceUrl) {
  var url = String(sourceUrl || '').trim();
  if (!url) return '';
  if (/\.zip(\?.*)?$/i.test(url)) return url;
  var match = url.match(/^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+?)(?:\.git)?\/?$/i);
  if (!match) return '';
  return 'https://github.com/' + match[1] + '/' + match[2] + '/archive/refs/heads/main.zip';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseDependEntries: parseDependEntries,
    githubMainZipUrl: githubMainZipUrl,
  };
}

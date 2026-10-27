/**
 * Block types stored in a workspace file that this StudioX cannot construct.
 * The workspace file stays untouched until those types exist again.
 */
(function (root) {
  function blockTypesInXml(xmlText) {
    var found = {};
    var re = /<(?:block|shadow)\b[^>]*\btype\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
    var match;
    var text = String(xmlText || '');
    while ((match = re.exec(text))) {
      var type = match[1] || match[2];
      if (type) found[type] = true;
    }
    return Object.keys(found);
  }

  function missingBlockTypes(xmlText, definedTypes) {
    var defined = definedTypes || {};
    return blockTypesInXml(xmlText).filter(function (type) {
      return !defined[type];
    });
  }

  function missingBlockMessage(types) {
    var list = (types || []).slice();
    if (!list.length) return '';
    return 'Missing extension block'
      + (list.length === 1 ? '' : 's')
      + ': ' + list.join(', ')
      + '. Install the extension that provides '
      + (list.length === 1 ? 'it' : 'them')
      + ' and restart StudioX. The saved workspace was not changed.';
  }

  var api = {
    blockTypesInXml: blockTypesInXml,
    missingBlockTypes: missingBlockTypes,
    missingBlockMessage: missingBlockMessage
  };
  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = api;
  }
  root.MissingBlocks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

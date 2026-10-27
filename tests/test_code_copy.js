const assert = require('assert');
const { textPanelFromNode } = require('../js/workspace/codePreview.js');

function el(id, parent) {
  return {
    nodeType: 1,
    id: id,
    parentElement: parent || null,
    closest: function(selectors) {
      var ids = selectors.split(',').map(function(part) {
        return part.trim().replace(/^#/, '');
      });
      var current = this;
      while (current) {
        if (ids.indexOf(current.id) !== -1) return current;
        current = current.parentElement;
      }
      return null;
    }
  };
}

const code = el('code-preview');
const codeText = { nodeType: 3, parentElement: code };
assert.strictEqual(textPanelFromNode(codeText).id, 'code-preview');

const log = el('console-log');
const line = el('output-line', log);
assert.strictEqual(textPanelFromNode({ nodeType: 3, parentElement: line }).id, 'console-log');

const blockly = el('blocklyDiv');
assert.strictEqual(textPanelFromNode({ nodeType: 3, parentElement: blockly }), null);
assert.strictEqual(textPanelFromNode(null), null);

const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'workspace', 'blockSelection.js'), 'utf8');
assert.ok(src.indexOf('textPanelFromNode') !== -1);
console.log('code copy ok');

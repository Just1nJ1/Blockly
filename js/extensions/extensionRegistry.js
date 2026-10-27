/**
 * Which extension owns each Blockly block type.
 * The Python server keeps the same map in server/extension_registry.py.
 */
(function (root) {
  var owners = {};
  var extensions = {};

  function registerExtension(record) {
    if (!record || !record.id) return;
    extensions[record.id] = record;
  }

  function claimBlock(extensionId, blockType) {
    if (!extensionId || !blockType) {
      return { ok: false, error: 'Block owner and type are required.' };
    }
    var current = owners[blockType];
    if (current && current !== extensionId) {
      return {
        ok: false,
        error: 'Block type ' + blockType + ' is already owned by ' + current + '.'
      };
    }
    owners[blockType] = extensionId;
    return { ok: true };
  }

  function ownerOf(blockType) {
    return owners[blockType] || null;
  }

  function collectUsedExtensionIds(workspace) {
    var ids = {};
    if (!workspace || typeof workspace.getAllBlocks !== 'function') return [];
    workspace.getAllBlocks(false).forEach(function (block) {
      if (!block) return;
      if (typeof block.isEnabled === 'function' && !block.isEnabled()) return;
      var owner = owners[block.type];
      if (owner) ids[owner] = true;
    });
    return Object.keys(ids);
  }

  var api = {
    registerExtension: registerExtension,
    claimBlock: claimBlock,
    ownerOf: ownerOf,
    collectUsedExtensionIds: collectUsedExtensionIds,
    owners: function () { return Object.assign({}, owners); }
  };
  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = api;
  }
  root.ExtensionRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

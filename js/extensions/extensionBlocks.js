/**
 * Extension Blockly blocks.
 *
 * Each extension may contribute a toolbox category plus block JSON:
 *
 *   "contributes": {
 *     "blocks": {
 *       "category": "Camera",
 *       "colour": "#4B8BBE",
 *       "files": ["blocks/blocks.json"]
 *     }
 *   }
 *
 * Block JSON is Blockly's defineBlocksWithJsonArray shape, plus:
 *   "python": "cap = cv2.VideoCapture({INDEX})\n"
 *   "pythonImports": ["import cv2"]
 *
 * {NAME} is a field (quoted unless field_number / field_checkbox) or an
 * input socket. Statement blocks should end with a newline. Blocks with
 * "output" generate a value expression.
 */
var _extensionBlockCategories = [];

function extensionBlockCategories() {
  return _extensionBlockCategories.map(function (cat) {
    return {
      kind: 'category',
      name: cat.name,
      colour: cat.colour,
      contents: cat.contents.slice()
    };
  });
}

function refreshExtensionBlocksToolbox() {
  if (typeof updateToolboxDisplay === 'function') {
    updateToolboxDisplay();
  }
}

async function registerExtensionBlocks(manifest, basePath, blocksContrib) {
  var spec = _normalizeBlocksContrib(blocksContrib, manifest);
  if (!spec || !spec.files.length) return;

  var blocks = [];
  for (var i = 0; i < spec.files.length; i++) {
    var rel = spec.files[i];
    var url = basePath + '/' + String(rel).replace(/^\//, '');
    try {
      var resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      if (!Array.isArray(data)) {
        console.warn('[Extensions] Block file must be an array:', rel);
        continue;
      }
      for (var j = 0; j < data.length; j++) blocks.push(data[j]);
    } catch (err) {
      console.warn('[Extensions] Failed to load blocks', rel, 'from', manifest.name, err);
    }
  }
  if (!blocks.length) return;

  var contents = [];
  for (var k = 0; k < blocks.length; k++) {
    var defined = _defineExtensionBlock(blocks[k], manifest.name);
    if (defined) contents.push({ kind: 'block', type: defined });
  }
  if (!contents.length) return;

  var existing = null;
  for (var c = 0; c < _extensionBlockCategories.length; c++) {
    if (_extensionBlockCategories[c].name === spec.category) {
      existing = _extensionBlockCategories[c];
      break;
    }
  }
  if (existing) {
    existing.contents = existing.contents.concat(contents);
  } else {
    _extensionBlockCategories.push({
      name: spec.category,
      colour: spec.colour,
      contents: contents
    });
  }
  console.log('[Extensions] Registered', contents.length, 'block(s) in', spec.category);
}

function _normalizeBlocksContrib(blocksContrib, manifest) {
  var category = (manifest && (manifest.displayName || manifest.name)) || 'Extension';
  var colour = '#6A5ACD';
  var files = [];
  if (!blocksContrib) return null;
  if (Array.isArray(blocksContrib)) {
    files = blocksContrib.slice();
  } else if (typeof blocksContrib === 'string') {
    files = [blocksContrib];
  } else if (typeof blocksContrib === 'object') {
    if (blocksContrib.category) category = String(blocksContrib.category);
    if (blocksContrib.colour || blocksContrib.color) {
      colour = blocksContrib.colour || blocksContrib.color;
    }
    if (Array.isArray(blocksContrib.files)) files = blocksContrib.files.slice();
    else if (Array.isArray(blocksContrib.definitions)) files = blocksContrib.definitions.slice();
    else if (typeof blocksContrib.file === 'string') files = [blocksContrib.file];
  }
  return { category: category, colour: colour, files: files };
}

function _defineExtensionBlock(def, extensionName) {
  if (!def || typeof def !== 'object' || !def.type) {
    console.warn('[Extensions] Skip block without type from', extensionName);
    return null;
  }
  var type = String(def.type);
  if (window.Blockly && Blockly.Blocks && Blockly.Blocks[type]) {
    console.warn('[Extensions] Block type already defined:', type);
    return null;
  }
  var json = {};
  var keys = Object.keys(def);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === 'python' || keys[i] === 'pythonImports' || keys[i] === 'pythonHidden') continue;
    json[keys[i]] = def[keys[i]];
  }
  _wireCameraDropdown(json);
  if (json.args0) {
    json.args0 = json.args0.map(function (arg) {
      if (!arg || typeof arg !== 'object') return arg;
      var copy = {};
      Object.keys(arg).forEach(function (key) {
        if (key === 'source' || key === 'unquoted') return;
        copy[key] = arg[key];
      });
      return copy;
    });
  }
  var defineBlocks = window.Blockly && (
    Blockly.defineBlocksWithJsonArray ||
    (Blockly.common && Blockly.common.defineBlocksWithJsonArray)
  );
  if (!defineBlocks) {
    console.warn('[Extensions] Blockly is not ready; cannot define', type);
    return null;
  }
  defineBlocks([json]);
  _registerExtensionGenerator(type, def.python, def.pythonImports, def);
  return type;
}

function _registerExtensionGenerator(type, template, imports, def) {
  function attach() {
    if (!window.Blockly || !Blockly.Python) return false;
    var target = Blockly.Python.forBlock || Blockly.Python;
    var args = def.args0 || [];
    var isValue = def.output !== undefined && def.previousStatement === undefined
      && def.nextStatement === undefined;
    target[type] = function (block, generator) {
      var gen = generator || Blockly.Python;
      (imports || []).forEach(function (line, idx) {
        if (!line) return;
        var filled = _fillBlockTemplate(block, gen, line, args);
        var key = 'camdef_' + (idx < 10 ? '0' : '') + idx + '_' + filled;
        if (Blockly.Python.definitions_) {
          Blockly.Python.definitions_[key] = filled;
        }
      });
      var code = _fillBlockTemplate(block, gen, template || '', args);
      if (def.type === 'camera_convert' && block.getFieldValue('MODE') === 'BGR') {
        code = _fillBlockTemplate(block, gen, '{IMAGE}', args);
      }
      if (isValue) {
        var order = (gen.ORDER_NONE != null) ? gen.ORDER_NONE : 99;
        return [code.trim(), order];
      }
      if (!code) return '';
      return code.charAt(code.length - 1) === '\n' ? code : code + '\n';
    };
    return true;
  }
  if (attach()) return;
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (attach() || tries > 50) clearInterval(timer);
  }, 100);
}

function _fillBlockTemplate(block, generator, template, args) {
  var argByName = {};
  (args || []).forEach(function (arg) {
    if (arg && arg.name) argByName[arg.name] = arg;
  });
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, function (_m, name) {
    var spec = argByName[name];
    var fieldType = spec && spec.type ? String(spec.type) : '';
    if (fieldType.indexOf('field_') === 0) {
      var val = block.getFieldValue(name);
      if (fieldType === 'field_number' || fieldType === 'field_checkbox') {
        var n = Number(val);
        return isFinite(n) ? String(n) : '0';
      }
      if (fieldType === 'field_dropdown' && /^-?\d+$/.test(String(val))) {
        return String(parseInt(val, 10));
      }
      if (spec && spec.unquoted) {
        return val == null ? '' : String(val);
      }
      return JSON.stringify(val == null ? '' : String(val));
    }
    if (fieldType === 'input_statement') {
      return generator.statementToCode(block, name) || '';
    }
    if (fieldType === 'input_value') {
      var order = (generator.ORDER_NONE != null) ? generator.ORDER_NONE : 99;
      return generator.valueToCode(block, name, order) || 'None';
    }
    var fallback = block.getFieldValue(name);
    if (fallback != null) return JSON.stringify(String(fallback));
    return 'None';
  });
}

function _wireCameraDropdown(json) {
  var args = json.args0 || [];
  var wants = false;
  for (var i = 0; i < args.length; i++) {
    if (args[i] && args[i].source === 'cameras') {
      delete args[i].source;
      wants = true;
    }
  }
  if (!wants) return;
  _registerCameraDropdown();
  var ext = json.extensions ? json.extensions.slice() : [];
  if (ext.indexOf('camera_list') < 0) ext.push('camera_list');
  json.extensions = ext;
}

function _registerCameraDropdown() {
  if (!window.Blockly || !Blockly.Extensions) return;
  if (Blockly.Extensions.isRegistered && Blockly.Extensions.isRegistered('camera_list')) return;
  if (!window._cameraBlockOptions) {
    window._cameraBlockOptions = [['No camera', '0']];
  }
  Blockly.Extensions.register('camera_list', function () {
    var field = this.getField('CAMERA');
    if (!field) return;
    field.menuGenerator_ = function () {
      var opts = window._cameraBlockOptions;
      return (opts && opts.length) ? opts : [['No camera', '0']];
    };
  });
  if (!window._cameraOptionTimer) {
    var pull = function () {
      var port = '5080';
      if (typeof getServerUrl === 'function') {
        var match = String(getServerUrl()).match(/:(\d+)/);
        if (match) port = match[1];
      }
      fetch('http://127.0.0.1:' + port + '/ext/camera/cameras')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var opts = [];
          ((data && data.cameras) || []).forEach(function (cam) {
            opts.push([cam.name || ('Camera ' + cam.id), String(cam.id)]);
          });
          if (opts.length) window._cameraBlockOptions = opts;
        })
        .catch(function () { /* extension not running yet */ });
    };
    pull();
    window._cameraOptionTimer = setInterval(pull, 4000);
  }
}

window.extensionBlockCategories = extensionBlockCategories;
window.refreshExtensionBlocksToolbox = refreshExtensionBlocksToolbox;
window.registerExtensionBlocks = registerExtensionBlocks;

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
    if (keys[i] === 'studiox' || keys[i] === 'portable' || keys[i] === 'simulation') continue;
    if (keys[i] === 'codegen' || keys[i] === 'hardware' || keys[i] === 'passComment') continue;
    json[keys[i]] = def[keys[i]];
  }
  if (json.args0 && window.DynamicFields) {
    json.args0.forEach(function (arg) {
      if (arg && arg.source) {
        window.DynamicFields.attach(json, arg.name, extensionName, arg.source);
      }
    });
  }
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
  if (window.ExtensionRegistry && typeof window.ExtensionRegistry.claimBlock === 'function') {
    var claim = window.ExtensionRegistry.claimBlock(extensionName, type);
    if (!claim.ok) {
      console.warn('[Extensions] ' + claim.error);
      return null;
    }
  }
  defineBlocks([json]);
  _registerExtensionGenerator(type, def.python, def.pythonImports, def, extensionName);
  return type;
}

var _generation = { target: 'studiox', purpose: 'execute' };
var _cleanups = [];

function _captureGeneration() {
  return { target: _generation.target, purpose: _generation.purpose };
}

function _applyGeneration(options) {
  options = options || {};
  _generation.target = options.target === 'portable' ? 'portable' : 'studiox';
  if (options.purpose === 'simulation' || options.purpose === 'export' || options.purpose === 'execute') {
    _generation.purpose = options.purpose;
  } else {
    _generation.purpose = 'execute';
  }
}

function _restoreGeneration(previous) {
  _generation.target = previous.target;
  _generation.purpose = previous.purpose;
}

function beginGeneration(options) {
  var previous = _captureGeneration();
  _applyGeneration(options);
  return function () { _restoreGeneration(previous); };
}

function _isValueBlock(def) {
  return !!(def && def.output !== undefined && def.previousStatement === undefined
    && def.nextStatement === undefined);
}

function _omitForGeneration(def) {
  if (!def) return false;
  var debugOnly = def.codegen === 'debug' || !!def.pythonHidden;
  var studioxOnly = def.codegen === 'studiox';
  if (debugOnly) {
    return !(_generation.target === 'studiox' && _generation.purpose === 'execute');
  }
  if (studioxOnly) return _generation.target === 'portable';
  return false;
}

function _passStatement(def) {
  var raw = def && def.passComment != null ? String(def.passComment) : '';
  var comment = raw.replace(/[\r\n]+/g, ' ').trim();
  if (!comment) return 'pass\n';
  return 'pass  # ' + comment + '\n';
}

function _omittedSpec(def) {
  return {
    omit: true,
    python: '',
    imports: [],
    cleanup: '',
    statement: _passStatement(def)
  };
}

function _normalizeSpec(spec, fallbackImports, def) {
  if (spec == null) return _omittedSpec(def);
  if (typeof spec === 'string') {
    return { omit: false, python: spec, imports: fallbackImports || [], cleanup: '' };
  }
  if (spec.omit) return _omittedSpec(def);
  var python = spec.python != null ? spec.python : '';
  var imports = spec.imports || spec.pythonImports || fallbackImports || [];
  return {
    omit: false,
    python: python,
    imports: imports,
    cleanup: spec.cleanup || ''
  };
}

function _specFor(def) {
  def = def || {};
  var target = _generation.target;
  var purpose = _generation.purpose;
  if (_omitForGeneration(def)) return _omittedSpec(def);
  if (target === 'portable') {
    if (def.portable) return _normalizeSpec(def.portable, [], def);
    return _normalizeSpec({ python: def.python, imports: def.pythonImports }, [], def);
  }
  if (purpose !== 'execute' && def.simulation) {
    return _normalizeSpec(def.simulation, [], def);
  }
  if (purpose !== 'execute' && def.hardware) {
    var message = (def.type || 'block') + ' is not available during simulation';
    return {
      omit: false,
      python: '__studiox_simulation_unsupported(' + JSON.stringify(message) + ')',
      imports: [],
      cleanup: ''
    };
  }
  if (def.studiox) return _normalizeSpec(def.studiox, def.pythonImports || [], def);
  return _normalizeSpec({ python: def.python, imports: def.pythonImports }, [], def);
}

function _procedureScope(block) {
  var current = block;
  while (current && typeof current.getSurroundParent === 'function') {
    current = current.getSurroundParent();
    if (!current) return null;
    if (current.type && String(current.type).indexOf('procedures_def') === 0) {
      return current.getFieldValue('NAME') || null;
    }
  }
  return null;
}

function _indentText(text, spaces) {
  var pad = new Array(spaces + 1).join(' ');
  return String(text || '').split('\n').map(function (line) {
    return line ? pad + line : line;
  }).join('\n');
}

function _finallyText(cleanups, indent) {
  var pad = new Array(indent + 1).join(' ');
  var lines = [pad + 'finally:'];
  cleanups.slice().reverse().forEach(function (item) {
    lines.push(pad + '    try:');
    String(item.code || '').split('\n').forEach(function (line) {
      if (line) lines.push(pad + '        ' + line);
    });
    lines.push(pad + '    except Exception:');
    lines.push(pad + '        pass');
  });
  return lines.join('\n');
}

function _wrapBody(text, cleanups) {
  var body = String(text || '').replace(/^\n+|\n+$/g, '');
  if (!body.trim()) return text;
  if (body.charAt(body.length - 1) !== '\n') body += '\n';
  return 'try:\n' + _indentText(body, 4) + '\n' + _finallyText(cleanups, 0) + '\n';
}

function _isImportOnly(text) {
  var any = false;
  var lines = String(text || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (!trimmed || trimmed.charAt(0) === '#') continue;
    any = true;
    if (!/^(import\s+|from\s+\S+\s+import\s+)/.test(trimmed)) return false;
  }
  return any;
}

function _splitTopLevel(code) {
  var lines = String(code || '').split('\n');
  var parts = [];
  var current = null;
  function start(kind, name) {
    if (current) parts.push(current);
    current = { kind: kind, name: name, lines: [] };
  }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var defMatch = line.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (defMatch) {
      start('def', defMatch[1]);
      current.lines.push(line);
      continue;
    }
    if (current && current.kind === 'def') {
      if (line.trim() === '' || /^\s/.test(line)) {
        current.lines.push(line);
        continue;
      }
      start('main', null);
      current.lines.push(line);
      continue;
    }
    if (!current) start('main', null);
    current.lines.push(line);
  }
  if (current) parts.push(current);
  return parts;
}

function wrapCleanups(code, cleanups) {
  var scoped = {};
  var main = [];
  (cleanups || []).forEach(function (item) {
    if (!item || !item.code) return;
    if (item.scope) {
      (scoped[item.scope] = scoped[item.scope] || []).push(item);
    } else {
      main.push(item);
    }
  });
  if (!main.length && !Object.keys(scoped).length) return code;
  var parts = _splitTopLevel(code);
  var chunks = parts.map(function (part) {
    var text = part.lines.join('\n');
    if (part.kind === 'def' && scoped[part.name]) {
      return _wrapDef(part, scoped[part.name]);
    }
    if (part.kind === 'main' && main.length && !_isImportOnly(text)) {
      return _wrapBody(text, main);
    }
    return text;
  });
  return chunks.join('\n');
}

function _wrapDef(part, cleanups) {
  var lines = part.lines.slice();
  var header = lines.shift() || '';
  while (lines.length && lines[0].trim() === '') lines.shift();
  var indent = '    ';
  for (var i = 0; i < lines.length; i++) {
    var found = lines[i].match(/^(\s+)\S/);
    if (found) {
      indent = found[1];
      break;
    }
  }
  var body = lines.map(function (line) {
    return line.indexOf(indent) === 0 ? line.slice(indent.length) : line;
  }).join('\n');
  var wrapped = _wrapBody(body || 'pass\n', cleanups);
  var indented = wrapped.split('\n').map(function (line) {
    return line ? indent + line : line;
  }).join('\n');
  return header + '\n' + indented;
}

function generatePython(workspace, options) {
  if (!workspace || !window.Blockly || !Blockly.Python) return '';
  var restore = beginGeneration(options);
  var previousCleanups = _cleanups;
  _cleanups = [];
  try {
    var code = Blockly.Python.workspaceToCode(workspace);
    if (_generation.target === 'portable') code = wrapCleanups(code, _cleanups);
    return code;
  } finally {
    _cleanups = previousCleanups;
    restore();
  }
}

function renderExtensionBlock(def, block, options) {
  var restore = beginGeneration(options);
  try {
    var spec = _specFor(def || {});
    var isValue = _isValueBlock(def);
    if (spec.omit) {
      return {
        omit: true,
        code: isValue ? 'None' : (spec.statement || 'pass\n'),
        imports: [],
        cleanup: ''
      };
    }
    var filler = {
      valueToCode: function () { return 'None'; },
      statementToCode: function () { return ''; },
      ORDER_NONE: 99
    };
    var chosen = _selectPythonTemplate(block, spec.python);
    var args = (def && def.args0) || [];
    var code = _fillBlockTemplate(block, filler, chosen || '', args);
    var cleanup = spec.cleanup ? _fillBlockTemplate(block, filler, spec.cleanup, args) : '';
    if (!isValue && code && code.charAt(code.length - 1) !== '\n') code += '\n';
    return { omit: false, code: code, imports: spec.imports || [], cleanup: cleanup };
  } finally {
    restore();
  }
}

function _selectPythonTemplate(block, template) {
  if (template && typeof template === 'object' && template.select) {
    var select = template.select;
    var value = block && typeof block.getFieldValue === 'function'
      ? block.getFieldValue(select.field) : undefined;
    var cases = select.cases || {};
    if (Object.prototype.hasOwnProperty.call(cases, value)) return cases[value];
    if (select.default != null) return select.default;
    throw new Error('No Python template for ' + (block && block.type) + ' when ' + select.field + '=' + value);
  }
  return template || '';
}

function _registerExtensionGenerator(type, template, imports, def, extensionName) {
  function attach() {
    if (!window.Blockly || !Blockly.Python) return false;
    var target = Blockly.Python.forBlock || Blockly.Python;
    var args = def.args0 || [];
    var isValue = _isValueBlock(def);
    target[type] = function (block, generator) {
      var gen = generator || Blockly.Python;
      var spec = _specFor(def);
      if (spec.omit) {
        if (isValue) {
          var omittedOrder = (gen.ORDER_NONE != null) ? gen.ORDER_NONE : 99;
          return ['None', omittedOrder];
        }
        return spec.statement || 'pass\n';
      }
      (spec.imports || []).forEach(function (line) {
        if (!line) return;
        var filledImport = _fillBlockTemplate(block, gen, line, args);
        var key = 'extension:' + (extensionName || 'extension') + ':import:' + filledImport;
        if (Blockly.Python.definitions_) {
          Blockly.Python.definitions_[key] = filledImport;
        }
      });
      var chosen = _selectPythonTemplate(block, spec.python);
      var code = _fillBlockTemplate(block, gen, chosen || '', args);
      if (_generation.target === 'portable' && spec.cleanup) {
        _cleanups.push({
          code: _fillBlockTemplate(block, gen, spec.cleanup, args),
          scope: _procedureScope(block)
        });
      }
      if (isValue) {
        var order = (gen.ORDER_NONE != null) ? gen.ORDER_NONE : 99;
        return [String(code || '').trim(), order];
      }
      if (!code) return 'pass\n';
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
      if (fieldType === 'field_variable') {
        if (generator && typeof generator.getVariableName === 'function') {
          return generator.getVariableName(val);
        }
        var varField = block.getField(name);
        return (varField && varField.getText) ? varField.getText() : String(val || 'cap');
      }
      if (fieldType === 'field_checkbox') {
        return (val === true || val === 'TRUE' || val === 'true') ? 'True' : 'False';
      }
      if (fieldType === 'field_number') {
        var n = Number(val);
        if (!isFinite(n)) n = 0;
        if (spec.min != null && isFinite(Number(spec.min)) && n < Number(spec.min)) n = Number(spec.min);
        if (spec.max != null && isFinite(Number(spec.max)) && n > Number(spec.max)) n = Number(spec.max);
        return String(n);
      }
      if (fieldType === 'field_dropdown' && /^-?\d+$/.test(String(val))) {
        return String(parseInt(val, 10));
      }
      if (spec && spec.unquoted) {
        var allowed = (spec.options || []).map(function (opt) {
          return Array.isArray(opt) ? String(opt[1]) : String(opt);
        });
        var raw = val == null ? '' : String(val);
        if (allowed.indexOf(raw) === -1 || /[\r\n]/.test(raw)) {
          throw new Error(
            'Unsafe dropdown value for ' + ((block && block.type) || 'block') + '.' + name
          );
        }
        return raw;
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
    console.warn(
      '[Extensions] ' + ((block && block.type) || 'block') + ' has no placeholder ' + name
    );
    return 'None';
  });
}

window.extensionBlockCategories = extensionBlockCategories;
window.ExtensionPython = {
  selectTemplate: _selectPythonTemplate,
  fillBlockTemplate: _fillBlockTemplate,
  generate: generatePython,
  begin: beginGeneration,
  wrapCleanups: wrapCleanups,
  renderExtensionBlock: renderExtensionBlock
};
window.refreshExtensionBlocksToolbox = refreshExtensionBlocksToolbox;
window.registerExtensionBlocks = registerExtensionBlocks;

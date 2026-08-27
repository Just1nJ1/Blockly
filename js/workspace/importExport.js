/**
 * Import/Export Module
 * Handles saving and loading workspace blocks to/from XML files.
 *
 * Import is always append (never replaces the workspace). Before loading:
 *  - User maps each file variable → create new / use existing / custom name.
 *  - setup_robot PORT values can be remapped via a dialog (like teaching import).
 *  - Legacy .blockly files are converted, then use the same mapping flow.
 *  - Block ids are stripped so a second import never collides with the first.
 */

/**
 * Export the current workspace blocks to an XML file.
 * Triggers a download of 'blockly_workspace.xml'.
 */
function exportBlocks() {
  const workspace = getWorkspace ? getWorkspace() : null;
  if (!workspace) return;

  const xml = Blockly.Xml.workspaceToDom(workspace);
  const xmlText = Blockly.Xml.domToText(xml);

  // Create a blob and download link
  const blob = new Blob([xmlText], { type: 'text/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'blockly_workspace.xml';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Generate a Blockly-style uid. */
function _importGenUid() {
  if (Blockly.utils && Blockly.utils.idGenerator &&
      typeof Blockly.utils.idGenerator.genUid === 'function') {
    return Blockly.utils.idGenerator.genUid();
  }
  return 'import_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Pick a free variable name: base, base_1, base_2, …
 * Respects both workspace names and names already claimed for this import.
 *
 * @param {string} base
 * @param {Set<string>|Object} reserved
 * @returns {string}
 */
function _uniqueVariableName(base, reserved) {
  function taken(n) {
    if (reserved instanceof Set) return reserved.has(n);
    return !!reserved[n];
  }
  if (!taken(base)) return base;
  let i = 1;
  while (taken(base + '_' + i)) i++;
  return base + '_' + i;
}

/**
 * Collect variable names already present in the workspace.
 * @param {Blockly.Workspace} workspace
 * @returns {Set<string>}
 */
function _workspaceVariableNames(workspace) {
  const names = new Set();
  if (!workspace || typeof workspace.getAllVariables !== 'function') return names;
  const all = workspace.getAllVariables();
  for (let i = 0; i < all.length; i++) {
    if (all[i] && all[i].name) names.add(all[i].name);
  }
  return names;
}

/**
 * Field names that store a robot/workspace variable as a plain string value
 * (FieldDropdown), not a Blockly FieldVariable id. Movement blocks use
 * VARIABLE this way via robotVarDropdownGenerator.
 */
var _NAME_BASED_VAR_FIELDS = {
  VARIABLE: true,
  VAR: true,
  INSTANCE: true
};

/**
 * Ensure <variables> exists on the workspace XML root.
 * @param {Element} xml
 * @returns {Element}
 */
function _ensureVariablesTag(xml) {
  let tag = xml.getElementsByTagName('variables')[0];
  if (tag) return tag;
  const doc = xml.ownerDocument || document;
  tag = doc.createElement('variables');
  if (xml.firstChild) xml.insertBefore(tag, xml.firstChild);
  else xml.appendChild(tag);
  return tag;
}

/**
 * Names referenced by movement blocks (FieldDropdown) but missing from the
 * <variables> list become silent fallbacks to the first dropdown option
 * ("robot"). Register them so import rename + Blockly load keep the real name.
 *
 * Example in a_blockly_workspace.xml: last write_coordinate uses r3, but r3
 * is never declared — only robot / r2 / r2_1 are.
 *
 * @param {Element} xml
 */
function injectOrphanVariableNames(xml) {
  if (!xml) return;
  const variablesTag = _ensureVariablesTag(xml);
  const declared = Object.create(null);
  const existing = variablesTag.getElementsByTagName('variable');
  for (let i = 0; i < existing.length; i++) {
    const n = (existing[i].textContent || '').trim();
    if (n) declared[n] = true;
  }

  const doc = xml.ownerDocument || document;
  const fields = xml.getElementsByTagName('field');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const fieldName = field.getAttribute('name') || '';
    if (!_NAME_BASED_VAR_FIELDS[fieldName]) continue;
    // FieldVariable entries already have an id and a <variable> row
    if (field.getAttribute('id')) continue;
    const text = (field.textContent || '').trim();
    if (!text || declared[text]) continue;

    const node = doc.createElement('variable');
    node.setAttribute('id', _importGenUid());
    node.textContent = text;
    variablesTag.appendChild(node);
    declared[text] = true;
  }
}

/**
 * Variables declared / referenced in import XML (after orphan injection).
 * @param {Element} xml
 * @returns {Array<{ name: string, id: string }>}
 */
function collectImportedVariables(xml) {
  injectOrphanVariableNames(xml);
  const out = [];
  const seen = Object.create(null);
  const variablesTag = xml.getElementsByTagName('variables')[0];
  if (!variablesTag) return out;
  const varNodes = variablesTag.getElementsByTagName('variable');
  for (let i = 0; i < varNodes.length; i++) {
    const node = varNodes[i];
    const name = (node.textContent || '').trim();
    if (!name || seen[name]) continue;
    let id = node.getAttribute('id');
    if (!id) {
      id = _importGenUid();
      node.setAttribute('id', id);
    }
    seen[name] = true;
    out.push({ name: name, id: id });
  }
  return out;
}

/**
 * True if this block element is (or is nested under) a procedure definition.
 * @param {Element} el
 * @returns {boolean}
 */
function _isInsideProcedureDef(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (cur.tagName && cur.tagName.toLowerCase() === 'block') {
      const type = cur.getAttribute('type') || '';
      if (type === 'procedures_defnoreturn' || type === 'procedures_defreturn' ||
          type.indexOf('procedures_def') === 0) {
        return true;
      }
    }
    cur = cur.parentNode;
  }
  return false;
}

/**
 * Procedure parameter names declared in import XML (should not appear in the
 * variable mapping dialog — they are function args, not workspace vars the
 * user manages).
 * @param {Element} xml
 * @returns {Object.<string, boolean>}
 */
function collectProcedureArgNamesFromXml(xml) {
  const names = Object.create(null);
  if (!xml) return names;
  const blocks = xml.getElementsByTagName('block');
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.getAttribute('shadow') != null) continue;
    const type = block.getAttribute('type') || '';
    if (type !== 'procedures_defnoreturn' && type !== 'procedures_defreturn' &&
        type.indexOf('procedures_def') !== 0) {
      continue;
    }
    // <mutation><arg name="a" varid="…">…</arg></mutation>
    const muts = block.getElementsByTagName('mutation');
    for (let m = 0; m < muts.length; m++) {
      if (muts[m].parentNode !== block) continue;
      const args = muts[m].getElementsByTagName('arg');
      for (let a = 0; a < args.length; a++) {
        const n = args[a].getAttribute('name') ||
          (args[a].textContent || '').trim();
        if (n) names[n] = true;
      }
    }
  }

  // Also: any <variable> whose every field reference with that id lives only
  // inside a procedure def is a param (covers serializations without arg name).
  const variablesTag = xml.getElementsByTagName('variables')[0];
  if (!variablesTag) return names;
  const varNodes = variablesTag.getElementsByTagName('variable');
  const idToName = Object.create(null);
  for (let v = 0; v < varNodes.length; v++) {
    const id = varNodes[v].getAttribute('id');
    const n = (varNodes[v].textContent || '').trim();
    if (id && n) idToName[id] = n;
  }
  const idUseOutsideDef = Object.create(null);
  const idUseInsideDef = Object.create(null);
  const fields = xml.getElementsByTagName('field');
  for (let f = 0; f < fields.length; f++) {
    const fid = fields[f].getAttribute('id');
    if (!fid || !idToName[fid]) continue;
    if (_isInsideProcedureDef(fields[f])) {
      idUseInsideDef[fid] = true;
    } else {
      idUseOutsideDef[fid] = true;
    }
  }
  Object.keys(idToName).forEach(function(id) {
    if (idUseInsideDef[id] && !idUseOutsideDef[id]) {
      names[idToName[id]] = true;
    }
  });
  return names;
}

/**
 * Variables to show in the import mapping dialog (excludes procedure params).
 * @param {Element} xml
 * @returns {Array<{ name: string, id: string }>}
 */
function collectImportedVariablesForDialog(xml) {
  const all = collectImportedVariables(xml);
  const params = collectProcedureArgNamesFromXml(xml);
  return all.filter(function(v) { return v && v.name && !params[v.name]; });
}

/**
 * Procedure definition names in XML (field NAME on procedures_def*).
 * @param {Element} xml
 * @returns {string[]}
 */
function collectProcedureNamesFromXml(xml) {
  const names = [];
  const seen = Object.create(null);
  if (!xml) return names;
  const blocks = xml.getElementsByTagName('block');
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.getAttribute('shadow') != null) continue;
    const type = block.getAttribute('type') || '';
    if (type !== 'procedures_defnoreturn' && type !== 'procedures_defreturn' &&
        type.indexOf('procedures_def') !== 0) {
      continue;
    }
    const fields = block.getElementsByTagName('field');
    for (let f = 0; f < fields.length; f++) {
      if (fields[f].parentNode !== block) continue;
      const fn = fields[f].getAttribute('name');
      if (fn === 'NAME' || fn === 'PROCNAME') {
        const n = (fields[f].textContent || '').trim();
        if (n && !seen[n]) {
          seen[n] = true;
          names.push(n);
        }
      }
    }
  }
  return names;
}

/**
 * Procedure names already on the workspace.
 * @param {Blockly.Workspace} workspace
 * @returns {Object.<string, boolean>}
 */
function _workspaceProcedureNames(workspace) {
  const set = Object.create(null);
  if (!workspace) return set;
  if (window.WorkflowSlots && typeof window.WorkflowSlots.listProcedures === 'function') {
    const list = window.WorkflowSlots.listProcedures(workspace) || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].name) set[list[i].name] = true;
    }
    return set;
  }
  const types = ['procedures_defnoreturn', 'procedures_defreturn'];
  for (let t = 0; t < types.length; t++) {
    if (typeof workspace.getBlocksByType !== 'function') break;
    const blocks = workspace.getBlocksByType(types[t], false) || [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.isInFlyout) continue;
      let name = b.getFieldValue && (b.getFieldValue('NAME') || b.getFieldValue('PROCNAME'));
      if (!name && typeof b.getProcedureDef === 'function') {
        try {
          const def = b.getProcedureDef();
          if (def && def[0]) name = def[0];
        } catch (e) { /* ignore */ }
      }
      if (name) set[name] = true;
    }
  }
  return set;
}

/**
 * Pick unique procedure names for definitions in the import XML that would
 * collide with the workspace (or with each other after rename).
 * @returns {Object.<string,string>} oldName → newName (only entries that change)
 */
function planProcedureRenames(xml, workspace) {
  const map = Object.create(null);
  const used = _workspaceProcedureNames(workspace);
  const imported = collectProcedureNamesFromXml(xml);
  for (let i = 0; i < imported.length; i++) {
    const original = imported[i];
    if (!used[original]) {
      // Reserve so a later import def with the same name also renames
      used[original] = true;
      continue;
    }
    // Already taken — allocate process2, process3, … (Blockly-style)
    let n = 2;
    let finalName = original + n;
    while (used[finalName]) {
      n++;
      finalName = original + n;
    }
    map[original] = finalName;
    used[finalName] = true;
  }
  return map;
}

/**
 * Apply procedure renames in import XML: def/call NAME fields and workflow
 * mutation slot_* attributes that reference the old function name.
 * @param {Element} xml
 * @param {Object.<string,string>} renameMap
 */
function applyProcedureRenamesToXml(xml, renameMap) {
  if (!xml || !renameMap) return;
  const keys = Object.keys(renameMap);
  if (!keys.length) return;

  function renameIfMatch(text) {
    const t = (text || '').trim();
    return renameMap[t] || null;
  }

  const fields = xml.getElementsByTagName('field');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const fname = field.getAttribute('name') || '';
    // Procedure def/call name fields
    if (fname === 'NAME' || fname === 'PROCNAME') {
      const next = renameIfMatch(field.textContent);
      if (next) field.textContent = next;
    }
  }

  // workflow_run mutation: slot_process="process" → process2
  const muts = xml.getElementsByTagName('mutation');
  for (let m = 0; m < muts.length; m++) {
    const mut = muts[m];
    if (!mut.attributes) continue;
    // Copy attribute list — live NamedNodeMap mutates
    const attrs = [];
    for (let a = 0; a < mut.attributes.length; a++) {
      attrs.push(mut.attributes[a]);
    }
    for (let a = 0; a < attrs.length; a++) {
      const attr = attrs[a];
      if (!attr.name || attr.name.indexOf('slot_') !== 0) continue;
      const next = renameIfMatch(attr.value);
      if (next) mut.setAttribute(attr.name, next);
    }
  }
}

/**
 * Look up a workspace variable by name (any type).
 * @param {Blockly.Workspace} workspace
 * @param {string} name
 * @returns {Object|null}
 */
function _workspaceVariableByName(workspace, name) {
  if (!workspace || !name) return null;
  if (typeof workspace.getVariable === 'function') {
    const v = workspace.getVariable(name) || workspace.getVariable(name, '');
    if (v) return v;
  }
  if (typeof workspace.getAllVariables === 'function') {
    const all = workspace.getAllVariables();
    for (let i = 0; i < all.length; i++) {
      if (all[i] && all[i].name === name) return all[i];
    }
  }
  return null;
}

/**
 * Apply user-chosen variable names for an import.
 * choices: { [fileVarName]: targetName }
 *
 * - If targetName already exists in the workspace, reuse that variable (same id).
 * - Otherwise create a new variable with a fresh id.
 * - Updates <variable> nodes and all FieldVariable / name-based VARIABLE fields.
 *
 * @param {Element} xml
 * @param {Blockly.Workspace} workspace
 * @param {Object.<string,string>} choices
 * @returns {{ renames: Array<{from:string,to:string}> }}
 */
function applyImportedVariableChoices(xml, workspace, choices) {
  const result = { renames: [] };
  if (!xml || !workspace) return result;

  injectOrphanVariableNames(xml);
  const variablesTag = xml.getElementsByTagName('variables')[0];
  if (!variablesTag) return result;

  choices = choices || {};
  const reserved = _workspaceVariableNames(workspace);
  // Names newly created by this import (not reused from workspace)
  const claimedNew = new Set();

  /** @type {Object.<string, {newId:string, newName:string, oldName:string}>} */
  const idRemap = Object.create(null);
  /** @type {Object.<string, string>} */
  const nameRemap = Object.create(null);

  const varNodes = variablesTag.getElementsByTagName('variable');
  for (let i = 0; i < varNodes.length; i++) {
    const node = varNodes[i];
    const oldName = (node.textContent || '').trim();
    if (!oldName) continue;
    let oldId = node.getAttribute('id');
    if (!oldId) {
      oldId = _importGenUid();
      node.setAttribute('id', oldId);
    }

    let wanted = (choices[oldName] != null ? String(choices[oldName]) : '').trim();
    if (!wanted) {
      wanted = _uniqueVariableName(oldName, reserved);
    }

    const existing = _workspaceVariableByName(workspace, wanted);
    let newId;
    let newName;

    if (existing) {
      // Reuse workspace variable
      newId = existing.getId();
      newName = existing.name;
    } else {
      // Create new — avoid colliding with other "create new" picks in this import
      const blockCreate = new Set(reserved);
      claimedNew.forEach(function(n) { blockCreate.add(n); });
      newName = blockCreate.has(wanted)
        ? _uniqueVariableName(wanted, blockCreate)
        : wanted;
      claimedNew.add(newName);
      reserved.add(newName);
      newId = _importGenUid();
    }

    idRemap[oldId] = { newId: newId, newName: newName, oldName: oldName };
    nameRemap[oldName] = newName;
    node.setAttribute('id', newId);
    node.textContent = newName;
    if (newName !== oldName) {
      result.renames.push({ from: oldName, to: newName });
    }
  }

  const fields = xml.getElementsByTagName('field');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const fid = field.getAttribute('id');
    const fieldName = field.getAttribute('name') || '';

    if (fid && idRemap[fid]) {
      const entry = idRemap[fid];
      field.setAttribute('id', entry.newId);
      if (entry.newName && (field.textContent || '').trim() !== entry.newName) {
        field.textContent = entry.newName;
      }
      continue;
    }

    if (_NAME_BASED_VAR_FIELDS[fieldName] && !fid) {
      const text = (field.textContent || '').trim();
      if (text && nameRemap[text]) {
        field.textContent = nameRemap[text];
      }
    }
  }

  return result;
}

/**
 * Default target name for a file variable (create-new suggestion).
 * @param {string} fileName
 * @param {Blockly.Workspace} workspace
 * @param {Set<string>} reservedExtra  names already suggested for other vars
 * @returns {string}
 */
function defaultImportVariableName(fileName, workspace, reservedExtra) {
  const reserved = _workspaceVariableNames(workspace);
  if (reservedExtra) {
    reservedExtra.forEach(function(n) { reserved.add(n); });
  }
  return _uniqueVariableName(fileName || 'robot', reserved);
}

/**
 * Shared control styles for import dialogs.
 */
function _importDialogSelectStyle() {
  return 'width:100%;padding:6px 8px;font-size:13px;margin-bottom:6px;' +
    'border:1px solid var(--border-primary);border-radius:4px;' +
    'background:var(--bg-primary);color:var(--text-primary);box-sizing:border-box;';
}

function _importDialogSectionTitle(text) {
  const el = document.createElement('div');
  el.style.cssText =
    'font-size:13px;font-weight:600;color:var(--text-primary);margin:4px 0 10px;' +
    'padding-bottom:6px;border-bottom:1px solid var(--border-faint);';
  el.textContent = text;
  return el;
}

/**
 * Unified import dialog: map variables and serial ports in one window.
 * onConfirm({ varChoices, portMapping })
 *
 * @param {Array<{name:string,id:string}>} fileVars
 * @param {Blockly.Workspace} workspace
 * @param {string[]} portKeys
 * @param {Object.<string,string>} portModelMap
 * @param {function({varChoices:Object, portMapping:Object|null})} onConfirm
 * @param {function()=} onCancel
 */
function showBlocklyImportMappingDialog(fileVars, workspace, portKeys, portModelMap, onConfirm, onCancel) {
  fileVars = fileVars || [];
  portKeys = portKeys || [];
  portModelMap = portModelMap || {};

  const hasVars = fileVars.length > 0;
  const hasPorts = portKeys.length > 0;

  if (!hasVars && !hasPorts) {
    onConfirm({ varChoices: {}, portMapping: null });
    return;
  }

  const existingNames = [];
  if (workspace && typeof workspace.getAllVariables === 'function') {
    const all = workspace.getAllVariables();
    for (let i = 0; i < all.length; i++) {
      if (all[i] && all[i].name) existingNames.push(all[i].name);
    }
    existingNames.sort(function(a, b) { return a.localeCompare(b); });
  }

  const suggested = Object.create(null);
  const usedSuggestions = new Set();
  for (let i = 0; i < fileVars.length; i++) {
    const s = defaultImportVariableName(fileVars[i].name, workspace, usedSuggestions);
    suggested[fileVars[i].name] = s;
    usedSuggestions.add(s);
  }

  const availPorts = getBlocklyImportAvailablePorts();
  let bypassChecked = false;

  function cleanup() {
    if (overlay.parentNode) document.body.removeChild(overlay);
  }

  const overlay = document.createElement('div');
  overlay.className = 'port-picker-overlay';
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) {
      cleanup();
      if (typeof onCancel === 'function') onCancel();
    }
  });

  const dialog = document.createElement('div');
  dialog.className = 'port-picker-dialog';
  dialog.style.width = '520px';

  const header = document.createElement('div');
  header.className = 'port-picker-header';
  let title = 'Import Blocks';
  if (hasVars && hasPorts) title = 'Map Variables & Ports';
  else if (hasVars) title = 'Map Variables for Import';
  else title = 'Map Ports for Import';
  header.innerHTML = '<span>' + title + '</span>';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'port-picker-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.onclick = function() {
    cleanup();
    if (typeof onCancel === 'function') onCancel();
  };
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  const body = document.createElement('div');
  body.className = 'port-picker-body';
  body.style.maxHeight = '480px';
  body.style.overflowY = 'auto';

  // ── Variables section ──
  /** @type {Array<{fileName:string, select:HTMLSelectElement, input:HTMLInputElement, defaultNew:string}>} */
  const varRows = [];

  if (hasVars) {
    body.appendChild(_importDialogSectionTitle('Variables'));
    const desc = document.createElement('div');
    desc.style.cssText =
      'font-size:12px;color:var(--text-secondary);margin-bottom:12px;line-height:1.45;';
    desc.textContent =
      'Choose which workspace variable each imported name should use. ' +
      'Default creates a new unique name. You can use an existing variable or a custom name.';
    body.appendChild(desc);

    for (let i = 0; i < fileVars.length; i++) {
      (function(fileName) {
        const defaultNew = suggested[fileName];

        const row = document.createElement('div');
        row.style.cssText =
          'margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border-faint);';

        const label = document.createElement('div');
        label.style.cssText =
          'font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-primary);';
        label.textContent = 'In file: ' + fileName;
        row.appendChild(label);

        const sel = document.createElement('select');
        sel.style.cssText = _importDialogSelectStyle();

        const optNew = document.createElement('option');
        optNew.value = '__new__';
        optNew.textContent = 'Create new variable: ' + defaultNew;
        sel.appendChild(optNew);

        for (let e = 0; e < existingNames.length; e++) {
          const opt = document.createElement('option');
          opt.value = '__existing__:' + existingNames[e];
          opt.textContent = 'Use existing: ' + existingNames[e];
          sel.appendChild(opt);
        }

        const optCustom = document.createElement('option');
        optCustom.value = '__custom__';
        optCustom.textContent = 'Custom name…';
        sel.appendChild(optCustom);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = defaultNew;
        input.placeholder = 'Variable name';
        input.style.cssText =
          'width:100%;padding:6px 8px;font-size:13px;box-sizing:border-box;' +
          'border:1px solid var(--border-primary);border-radius:4px;' +
          'background:var(--bg-primary);color:var(--text-primary);';

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:4px;';

        function syncFromSelect() {
          const v = sel.value;
          if (v === '__new__') {
            input.value = defaultNew;
            input.style.display = 'none';
            hint.textContent = 'Will create a new variable named “' + defaultNew + '”.';
          } else if (v.indexOf('__existing__:') === 0) {
            const ex = v.slice('__existing__:'.length);
            input.value = ex;
            input.style.display = 'none';
            hint.textContent = 'Imported blocks using “' + fileName +
              '” will use existing “' + ex + '”.';
          } else {
            input.style.display = '';
            input.readOnly = false;
            if (!input.value || input.value === defaultNew ||
                existingNames.indexOf(input.value) !== -1) {
              input.value = '';
            }
            input.focus();
            hint.textContent =
              'Type any name. Existing names are reused; new names are created.';
          }
        }

        sel.addEventListener('change', syncFromSelect);
        input.addEventListener('input', function() {
          if (sel.value !== '__custom__') return;
          const n = input.value.trim();
          if (!n) {
            hint.textContent =
              'Type any name. Existing names are reused; new names are created.';
            return;
          }
          const exists = existingNames.indexOf(n) !== -1;
          hint.textContent = exists
            ? '“' + n + '” already exists — it will be reused.'
            : 'Will create a new variable named “' + n + '”.';
        });

        row.appendChild(sel);
        row.appendChild(input);
        row.appendChild(hint);
        body.appendChild(row);
        syncFromSelect();

        varRows.push({
          fileName: fileName,
          select: sel,
          input: input,
          defaultNew: defaultNew
        });
      })(fileVars[i].name);
    }
  }

  // ── Ports section ──
  /** @type {Object.<string, {select:HTMLSelectElement, populate:Function}>} */
  const portSelects = {};

  if (hasPorts) {
    if (hasVars) {
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:8px;';
      body.appendChild(spacer);
    }
    body.appendChild(_importDialogSectionTitle('Serial ports'));
    const pdesc = document.createElement('div');
    pdesc.style.cssText =
      'font-size:12px;color:var(--text-secondary);margin-bottom:12px;line-height:1.45;';
    pdesc.textContent =
      'Map each serial port from the file to a port on this machine, or keep the original value.';
    body.appendChild(pdesc);

    for (let k = 0; k < portKeys.length; k++) {
      (function(origPort) {
        const expectedModel = portModelMap[origPort] || '';
        const expectedLabel = _modelDisplayName(expectedModel);
        // Legacy .blockly: no port in file — user must assign one (no "Keep …")
        const needsAssign = (origPort === LEGACY_PORT_PLACEHOLDER || !origPort);

        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:10px;';

        const label = document.createElement('div');
        label.style.cssText =
          'font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-primary);';
        if (needsAssign) {
          label.textContent = 'Serial port (not specified in file)' +
            (expectedLabel ? ' — model ' + expectedLabel : '');
        } else {
          label.textContent = origPort + (expectedLabel ? ' (' + expectedLabel + ')' : '');
        }
        row.appendChild(label);

        const sel = document.createElement('select');
        sel.style.cssText = _importDialogSelectStyle();

        function setSelectValue(desired) {
          // Prefer selectedIndex so WebKit/Electron paints the label (setting
          // .value before the <select> is in the document often leaves it blank).
          let idx = -1;
          for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === desired && !sel.options[i].disabled) {
              idx = i;
              break;
            }
          }
          if (idx < 0 && !needsAssign) {
            for (let i = 0; i < sel.options.length; i++) {
              if (sel.options[i].value === '__keep__') { idx = i; break; }
            }
          }
          if (idx < 0 && sel.options.length) {
            // First non-disabled option
            for (let i = 0; i < sel.options.length; i++) {
              if (!sel.options[i].disabled) { idx = i; break; }
            }
          }
          if (idx >= 0) {
            sel.selectedIndex = idx;
            sel.options[idx].selected = true;
          }
        }

        function populateSelect() {
          const curVal = sel.value;
          sel.innerHTML = '';

          // Only offer "Keep …" when the file actually defined a port
          if (!needsAssign) {
            const keep = document.createElement('option');
            keep.value = '__keep__';
            keep.textContent = 'Keep ' + origPort +
              (expectedLabel ? ' (' + expectedLabel + ')' : '');
            sel.appendChild(keep);
          } else {
            const prompt = document.createElement('option');
            prompt.value = '';
            prompt.disabled = true;
            prompt.textContent = 'Select a port…';
            sel.appendChild(prompt);
          }

          let hasOther = false;
          for (let p = 0; p < availPorts.length; p++) {
            const ap = availPorts[p];
            const modelMatch = !expectedModel || !ap.modelValue ||
              ap.modelValue === expectedModel ||
              _modelDisplayName(ap.modelValue) === expectedLabel;
            if (!bypassChecked && expectedModel && ap.modelValue && !modelMatch) continue;

            const opt = document.createElement('option');
            opt.value = ap.port;
            opt.textContent = ap.label +
              (!modelMatch && ap.modelValue ? ' [different model]' : '');
            opt.dataset.modelValue = ap.modelValue || '';
            sel.appendChild(opt);
            hasOther = true;
          }

          if (!hasOther && availPorts.length === 0) {
            const none = document.createElement('option');
            none.value = '';
            none.disabled = true;
            none.textContent = 'No connected ports detected';
            sel.appendChild(none);
          }

          let desired = curVal;
          if (!desired || desired === LEGACY_PORT_PLACEHOLDER) {
            let auto = null;
            if (!needsAssign) {
              for (let p = 0; p < availPorts.length; p++) {
                if (availPorts[p].port === origPort) { auto = availPorts[p].port; break; }
              }
            }
            if (!auto && expectedModel) {
              for (let p = 0; p < availPorts.length; p++) {
                const ap = availPorts[p];
                if (ap.modelValue === expectedModel ||
                    _modelDisplayName(ap.modelValue) === expectedLabel) {
                  auto = ap.port;
                  break;
                }
              }
            }
            if (!auto && availPorts.length > 0) auto = availPorts[0].port;
            desired = auto || (needsAssign ? '' : '__keep__');
          }
          setSelectValue(desired);
        }

        portSelects[origPort] = { select: sel, populate: populateSelect, needsAssign: needsAssign };
        row.appendChild(sel);
        body.appendChild(row);
        // Populate after the select is in the document so the label paints
        populateSelect();
      })(portKeys[k]);
    }

    const cbRow = document.createElement('div');
    cbRow.style.cssText = 'margin-top:8px;display:flex;align-items:center;gap:6px;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'blockly-import-bypass';
    const cbLabel = document.createElement('label');
    cbLabel.htmlFor = 'blockly-import-bypass';
    cbLabel.style.cssText = 'font-size:12px;color:var(--text-secondary);cursor:pointer;';
    cbLabel.textContent = 'Show all ports (ignore model restriction)';
    cb.addEventListener('change', function() {
      bypassChecked = cb.checked;
      for (const key in portSelects) {
        if (Object.prototype.hasOwnProperty.call(portSelects, key)) {
          portSelects[key].populate();
        }
      }
    });
    cbRow.appendChild(cb);
    cbRow.appendChild(cbLabel);
    body.appendChild(cbRow);
  }

  dialog.appendChild(body);

  const footer = document.createElement('div');
  footer.style.cssText =
    'display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;' +
    'border-top:1px solid var(--border-faint);';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'port-picker-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText =
    'padding:6px 16px;border:1px solid var(--border-primary);border-radius:4px;' +
    'background:var(--bg-primary);color:var(--text-primary);cursor:pointer;font-size:13px;';
  cancelBtn.onclick = function() {
    cleanup();
    if (typeof onCancel === 'function') onCancel();
  };
  footer.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Import';
  confirmBtn.style.cssText =
    'padding:6px 16px;border:1px solid #388E3C;border-radius:4px;' +
    'background:#4CAF50;color:#fff;cursor:pointer;font-size:13px;font-weight:500;';
  confirmBtn.addEventListener('click', function() {
    const varChoices = Object.create(null);
    for (let r = 0; r < varRows.length; r++) {
      const row = varRows[r];
      let name = (row.input.value || '').trim();
      if (!name) name = row.defaultNew;
      if (!name) {
        alert('Please enter a variable name for “' + row.fileName + '”.');
        if (row.select.value === '__custom__') row.input.focus();
        return;
      }
      varChoices[row.fileName] = name;
    }

    let portMapping = null;
    if (hasPorts) {
      portMapping = {};
      for (const key in portSelects) {
        if (!Object.prototype.hasOwnProperty.call(portSelects, key)) continue;
        const entry = portSelects[key];
        const s = entry.select;
        const val = s.value;
        // Legacy unassigned: must pick a real port
        if (entry.needsAssign && (!val || val === LEGACY_PORT_PLACEHOLDER)) {
          alert('Please select a serial port for the imported robot.');
          s.focus();
          return;
        }
        if (!val || val === '__keep__') {
          // Keep file port only when the file actually had one
          if (key === LEGACY_PORT_PLACEHOLDER) {
            alert('Please select a serial port for the imported robot.');
            s.focus();
            return;
          }
          portMapping[key] = { port: key, model: portModelMap[key] || '' };
          continue;
        }
        let modelValue = '';
        const opt = s.options[s.selectedIndex];
        if (opt && opt.dataset && opt.dataset.modelValue) {
          modelValue = opt.dataset.modelValue;
        }
        if (!modelValue && window.portModelMap && window.portModelMap[val]) {
          modelValue = window.portModelMap[val];
        }
        if (!modelValue) modelValue = portModelMap[key] || '';
        portMapping[key] = { port: val, model: modelValue };
      }
    }

    cleanup();
    onConfirm({ varChoices: varChoices, portMapping: portMapping });
  });
  footer.appendChild(confirmBtn);

  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // WebKit/Electron: re-apply selectedIndex after the dialog is in the document
  // so port dropdown labels actually paint (otherwise field can look empty until re-open).
  if (hasPorts) {
    requestAnimationFrame(function() {
      for (const key in portSelects) {
        if (Object.prototype.hasOwnProperty.call(portSelects, key)) {
          const s = portSelects[key].select;
          const v = s.value;
          for (let i = 0; i < s.options.length; i++) {
            if (s.options[i].value === v && !s.options[i].disabled) {
              s.selectedIndex = i;
              s.options[i].selected = true;
              break;
            }
          }
        }
      }
    });
  }
}

/**
 * Strip block/shadow/comment ids so append never collides with existing blocks
 * (importing the same file twice would otherwise reuse ids).
 * @param {Element} xml
 */
function stripImportedBlockIds(xml) {
  if (!xml) return;
  const tags = ['block', 'shadow', 'comment'];
  for (let t = 0; t < tags.length; t++) {
    const nodes = xml.getElementsByTagName(tags[t]);
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].removeAttribute('id');
    }
  }
}

/**
 * Placeholder PORT for legacy .blockly imports (old files have no serial port).
 * Must be remapped to a real port before load; never shown as "Keep …".
 */
var LEGACY_PORT_PLACEHOLDER = '__unassigned__';

/**
 * Collect unique PORT (+ MODEL) values from setup_robot blocks in the XML.
 * @param {Element} xml
 * @returns {{ portKeys: string[], portModelMap: Object.<string,string> }}
 */
function collectImportedSetupPorts(xml) {
  const portModelMap = Object.create(null);
  const portKeys = [];
  if (!xml) return { portKeys: portKeys, portModelMap: portModelMap };

  const blocks = xml.getElementsByTagName('block');
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.getAttribute('type') !== 'setup_robot') continue;

    let port = null;
    let model = null;
    const fields = block.getElementsByTagName('field');
    // Only direct field children of this block (not nested next/value blocks)
    for (let f = 0; f < fields.length; f++) {
      const field = fields[f];
      if (field.parentNode !== block) continue;
      const name = field.getAttribute('name');
      const val = (field.textContent || '').trim();
      if (name === 'PORT') port = val;
      else if (name === 'MODEL') model = val;
    }
    // Empty / placeholder → still need assignment (legacy files have no port)
    if (!port) port = LEGACY_PORT_PLACEHOLDER;
    if (!portModelMap[port]) {
      portModelMap[port] = model || 'Mirobot_UART';
      portKeys.push(port);
    }
  }
  return { portKeys: portKeys, portModelMap: portModelMap };
}

/**
 * Apply port (+ optional model) mapping onto setup_robot fields in the XML.
 * @param {Element} xml
 * @param {Object.<string, {port:string, model?:string}>} mapping
 */
function applyPortMappingToXml(xml, mapping) {
  if (!xml || !mapping) return;
  const blocks = xml.getElementsByTagName('block');
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.getAttribute('type') !== 'setup_robot') continue;

    let portField = null;
    let modelField = null;
    const fields = block.getElementsByTagName('field');
    for (let f = 0; f < fields.length; f++) {
      const field = fields[f];
      if (field.parentNode !== block) continue;
      const name = field.getAttribute('name');
      if (name === 'PORT') portField = field;
      else if (name === 'MODEL') modelField = field;
    }
    if (!portField) continue;
    let orig = (portField.textContent || '').trim();
    if (!orig) orig = LEGACY_PORT_PLACEHOLDER;
    // Prefer exact key; fall back to placeholder for legacy unassigned ports
    const mapped = mapping[orig] || mapping[LEGACY_PORT_PLACEHOLDER];
    if (!mapped || !mapped.port || mapped.port === LEGACY_PORT_PLACEHOLDER) continue;
    portField.textContent = mapped.port;
    if (mapped.model && modelField) {
      modelField.textContent = mapped.model;
    }
  }
}

/**
 * Friendly model label for dialogs (Mirobot_UART → Mirobot).
 * @param {string} modelValue
 * @returns {string}
 */
function _modelDisplayName(modelValue) {
  if (!modelValue) return 'Unknown';
  if (window.RobotCatalog && typeof window.RobotCatalog.normalizeModelName === 'function') {
    return window.RobotCatalog.normalizeModelName(modelValue) || 'Unknown';
  }
  if (typeof window.normalizeRobotModelName === 'function') {
    return window.normalizeRobotModelName(modelValue) || 'Unknown';
  }
  return String(modelValue).replace(/_UART$/i, '').replace(/_USB$/i, '');
}

/**
 * Available serial ports for the import mapping dialog.
 * Prefer live detected ports (includes virtual ports from robots.json).
 * @returns {Array<{port:string, label:string, model:string, modelValue:string}>}
 */
function getBlocklyImportAvailablePorts() {
  const out = [];
  const seen = Object.create(null);

  function add(port, label, modelValue) {
    if (!port || seen[port]) return;
    // Skip detecting placeholders
    if (String(port).indexOf('__detecting__') === 0) return;
    seen[port] = true;
    const modelValueSafe = modelValue ||
      (window.portModelMap && window.portModelMap[port]) || '';
    out.push({
      port: port,
      label: label || port,
      model: _modelDisplayName(modelValueSafe) || '',
      modelValue: modelValueSafe || ''
    });
  }

  if (window.detectedPorts && window.detectedPorts.length) {
    for (let i = 0; i < window.detectedPorts.length; i++) {
      const pair = window.detectedPorts[i];
      // pair is [label, value]
      if (Array.isArray(pair)) add(pair[1], pair[0], window.portModelMap && window.portModelMap[pair[1]]);
    }
  }

  // Always include built-in virtual devices from catalog even if detector not ready
  if (window.RobotCatalog && typeof window.RobotCatalog.getVirtualDeviceEntries === 'function') {
    const entries = window.RobotCatalog.getVirtualDeviceEntries();
    const map = window.RobotCatalog.getVirtualPortModelMap();
    for (let v = 0; v < entries.length; v++) {
      const d = entries[v];
      add(d.port, d.port + ' (' + d.model + ')', map[d.port] || (d.model + '_UART'));
    }
  } else {
    add('VirtualMirobot', 'VirtualMirobot (Mirobot)', 'Mirobot_UART');
    add('VirtualMT4', 'VirtualMT4 (MT4)', 'MT4_UART');
  }

  // Also scrape command/teach/control selects
  const selectIds = ['command-port-select', 'teach-port-select', 'ctrl-port-select'];
  for (let s = 0; s < selectIds.length; s++) {
    const sel = document.getElementById(selectIds[s]);
    if (!sel) continue;
    for (let o = 0; o < sel.options.length; o++) {
      const opt = sel.options[o];
      if (opt.disabled || !opt.value) continue;
      add(opt.value, opt.textContent, window.portModelMap && window.portModelMap[opt.value]);
    }
  }

  return out;
}

/**
 * Finalize append-import after optional port mapping and variable choices.
 * @param {Element} xml
 * @param {Blockly.Workspace} workspace
 * @param {Object.<string,{port:string,model?:string}>|null} portMapping
 * @param {Object.<string,string>|null} varChoices  fileVarName → targetName
 */
function finishBlocklyImport(xml, workspace, portMapping, varChoices) {
  if (portMapping) {
    applyPortMappingToXml(xml, portMapping);
  }

  // Procedure params: auto-reuse same names (no dialog); merge with user choices
  const paramNames = collectProcedureArgNamesFromXml(xml);
  const mergedChoices = Object.assign({}, varChoices || {});
  Object.keys(paramNames).forEach(function(pn) {
    if (mergedChoices[pn] == null) mergedChoices[pn] = pn;
  });
  applyImportedVariableChoices(xml, workspace, mergedChoices);

  // Rename colliding procedures in XML before load, and keep workflow slots in sync
  const procRenames = planProcedureRenames(xml, workspace);
  applyProcedureRenamesToXml(xml, procRenames);

  stripImportedBlockIds(xml);

  if (typeof Blockly.Xml.appendDomToWorkspace === 'function') {
    Blockly.Xml.appendDomToWorkspace(xml, workspace);
  } else {
    Blockly.Xml.domToWorkspace(xml, workspace);
  }

  // Safety: if Blockly still renamed something, pending state is already updated
  // from XML; rebuild workflow blocks so dropdowns show process2 / combine2
  if (typeof window.applyProcedureRenamesToWorkflows === 'function' &&
      Object.keys(procRenames).length) {
    window.applyProcedureRenamesToWorkflows(workspace, procRenames);
  } else if (typeof window.refreshWorkflowBlocks === 'function') {
    window.refreshWorkflowBlocks(workspace);
  }

  if (typeof updateCodePreview === 'function') {
    updateCodePreview();
  }
}

// ═══════════════════════════════════════════════════════════════════
// Legacy .blockly format (older WLKATA single-robot Blockly app)
// ═══════════════════════════════════════════════════════════════════

/**
 * Old custom block types from .blockly files → new StudioX types.
 * Standard Blockly types (controls_*, math_*, …) pass through if registered.
 */
var LEGACY_BLOCKLY_TYPES = {
  MoveTo: true,
  SuctionCup: true,
  LED: true,
  Speed: true,
  Delay: true,
  SliderMoveTo: true
};

/**
 * @param {Element} xml
 * @returns {string[]} unique block types (not shadows)
 */
function collectBlockTypesInXml(xml) {
  const types = [];
  const seen = Object.create(null);
  if (!xml) return types;
  const blocks = xml.getElementsByTagName('block');
  for (let i = 0; i < blocks.length; i++) {
    const t = blocks[i].getAttribute('type');
    if (!t || seen[t]) continue;
    seen[t] = true;
    types.push(t);
  }
  return types;
}

/**
 * True if every block type is either a known legacy type or a registered
 * Blockly block (including standard library blocks).
 * @param {string[]} types
 * @returns {{ ok: boolean, unsupported: string[] }}
 */
function validateImportBlockTypes(types) {
  const unsupported = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (LEGACY_BLOCKLY_TYPES[t]) continue;
    if (typeof Blockly !== 'undefined' && Blockly.Blocks && Blockly.Blocks[t]) continue;
    unsupported.push(t);
  }
  return { ok: unsupported.length === 0, unsupported: unsupported };
}

/**
 * @param {Element} xml
 * @returns {boolean}
 */
function xmlContainsLegacyBlocks(xml) {
  const types = collectBlockTypesInXml(xml);
  for (let i = 0; i < types.length; i++) {
    if (LEGACY_BLOCKLY_TYPES[types[i]]) return true;
  }
  return false;
}

/**
 * Create an element compatible with Blockly workspace XML.
 * Prefer Blockly.utils.xml.createElement so namespaces match.
 * @param {Element} xml
 * @param {string} tag
 * @returns {Element}
 */
function _xmlEl(xml, tag) {
  if (Blockly.utils && Blockly.utils.xml &&
      typeof Blockly.utils.xml.createElement === 'function') {
    return Blockly.utils.xml.createElement(tag);
  }
  const doc = xml.ownerDocument || document;
  if (doc.createElementNS && xml.namespaceURI) {
    return doc.createElementNS(xml.namespaceURI, tag);
  }
  return doc.createElement(tag);
}

/**
 * Direct child elements of a block with the given tag (local name).
 * @param {Element} block
 * @param {string} tag
 * @returns {Element[]}
 */
function _directChildren(block, tag) {
  const out = [];
  const kids = block.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType !== 1) continue;
    const name = n.tagName && n.tagName.toLowerCase();
    if (name === tag.toLowerCase()) out.push(n);
  }
  return out;
}

/**
 * @param {Element} block
 * @param {string} fieldName
 * @returns {string|null}
 */
function _getFieldText(block, fieldName) {
  const fields = _directChildren(block, 'field');
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].getAttribute('name') === fieldName) {
      return (fields[i].textContent || '').trim();
    }
  }
  return null;
}

/**
 * Remove direct field children by name.
 * @param {Element} block
 * @param {string[]} names
 */
function _removeFields(block, names) {
  const set = Object.create(null);
  for (let i = 0; i < names.length; i++) set[names[i]] = true;
  const fields = _directChildren(block, 'field');
  for (let i = 0; i < fields.length; i++) {
    if (set[fields[i].getAttribute('name')]) {
      block.removeChild(fields[i]);
    }
  }
}

/**
 * Insert a field as the first child (before values/next).
 * @param {Element} block
 * @param {string} name
 * @param {string} value
 * @param {string=} id  optional variable id
 */
function _prependField(block, name, value, id) {
  const field = _xmlEl(block, 'field');
  field.setAttribute('name', name);
  if (id) field.setAttribute('id', id);
  field.textContent = value;
  if (block.firstChild) block.insertBefore(field, block.firstChild);
  else block.appendChild(field);
}

/**
 * Rename a direct <value name="old"> to new name.
 * @param {Element} block
 * @param {string} from
 * @param {string} to
 */
function _renameValue(block, from, to) {
  const values = _directChildren(block, 'value');
  for (let i = 0; i < values.length; i++) {
    if (values[i].getAttribute('name') === from) {
      values[i].setAttribute('name', to);
    }
  }
}

/**
 * Convert one legacy block element in place to a modern StudioX block.
 * @param {Element} block
 * @param {string} robotVar
 * @returns {void}
 */
function convertLegacyBlockElement(block, robotVar) {
  const type = block.getAttribute('type');
  if (!type || !LEGACY_BLOCKLY_TYPES[type]) return;

  if (type === 'MoveTo') {
    // MOVL → Linear G01 (1); MOVJ → Fast G00 (0)
    const motionRaw = (_getFieldText(block, 'motion') || 'MOVL').toUpperCase();
    const locationRaw = (_getFieldText(block, 'location') || 'absolute').toLowerCase();
    const motion = (motionRaw === 'MOVJ' || motionRaw === 'FAST' || motionRaw === 'G00') ? '0' : '1';
    const position = (locationRaw === 'relative' || locationRaw === 'incremental' ||
      locationRaw === '1') ? '1' : '0';

    _removeFields(block, ['motion', 'location']);
    block.setAttribute('type', 'write_coordinate');
    // Prepend fields in reverse so VARIABLE ends up first
    _prependField(block, 'POSITION', position);
    _prependField(block, 'MOTION', motion);
    _prependField(block, 'VARIABLE', robotVar);

    _renameValue(block, 'x', 'AXIS_X');
    _renameValue(block, 'y', 'AXIS_Y');
    _renameValue(block, 'z', 'AXIS_Z');
    _renameValue(block, 'rx', 'AXIS_A');
    _renameValue(block, 'ry', 'AXIS_B');
    _renameValue(block, 'rz', 'AXIS_C');
    return;
  }

  if (type === 'SuctionCup') {
    const modeRaw = (_getFieldText(block, 'SuctionCup') || 'Off').toLowerCase();
    // On → SUCTION (1); Off → OFF (0)
    const mode = (modeRaw === 'on' || modeRaw === '1' || modeRaw === 'suction') ? '1' : '0';
    _removeFields(block, ['SuctionCup']);
    block.setAttribute('type', 'robot_pump');
    _prependField(block, 'MODE', mode);
    _prependField(block, 'VARIABLE', robotVar);
    return;
  }

  if (type === 'LED') {
    // BallGripper On/Off → gripper CLOSE (2) / OFF (0)
    const modeRaw = (_getFieldText(block, 'BallGripper') ||
      _getFieldText(block, 'LED') || 'Off').toLowerCase();
    const mode = (modeRaw === 'on' || modeRaw === '1' || modeRaw === 'close') ? '2' : '0';
    _removeFields(block, ['BallGripper', 'LED']);
    block.setAttribute('type', 'robot_gripper');
    _prependField(block, 'MODE', mode);
    _prependField(block, 'VARIABLE', robotVar);
    return;
  }

  if (type === 'Speed') {
    block.setAttribute('type', 'robot_speed');
    _prependField(block, 'VARIABLE', robotVar);
    _renameValue(block, 'F', 'SPEED');
    _renameValue(block, 'f', 'SPEED');
    return;
  }

  if (type === 'Delay') {
    block.setAttribute('type', 'robot_delay');
    _renameValue(block, 't', 'TIME');
    _renameValue(block, 'T', 'TIME');
    _renameValue(block, 'NUM', 'TIME');
    return;
  }

  if (type === 'SliderMoveTo') {
    // 7th-axis / rail → conveyor writeExpand; d is position, f (feed) dropped
    block.setAttribute('type', 'robot_conveyor');
    _prependField(block, 'POSITION', '0'); // absolute
    _prependField(block, 'MOTION', '0');   // fast
    _prependField(block, 'VARIABLE', robotVar);
    _renameValue(block, 'd', 'D');
    _renameValue(block, 'D', 'D');
    // Remove unused feed value if present (not on modern conveyor block)
    const values = _directChildren(block, 'value');
    for (let i = 0; i < values.length; i++) {
      const vn = values[i].getAttribute('name');
      if (vn === 'f' || vn === 'F') {
        block.removeChild(values[i]);
      }
    }
    return;
  }
}

/**
 * Convert an entire legacy workspace XML to modern StudioX format.
 * Adds setup_robot with variable "robot" (file-side name); the import
 * variable-mapping dialog lets the user pick the final name (e.g. robot_1 / abc).
 *
 * @param {Element} xml
 * @param {Blockly.Workspace} workspace
 * @returns {{ robotVar: string }}
 */
function convertLegacyBlocklyXml(xml, workspace) {
  const robotVar = 'robot';
  const robotId = _importGenUid();

  // Snapshot all <block> nodes first — live NodeList changes as we edit
  const allBlocks = Array.prototype.slice.call(xml.getElementsByTagName('block'));
  for (let i = 0; i < allBlocks.length; i++) {
    convertLegacyBlockElement(allBlocks[i], robotVar);
  }

  // Ensure <variables> includes the new robot variable (for setup_robot FieldVariable)
  let variablesTag = xml.getElementsByTagName('variables')[0];
  if (!variablesTag) {
    variablesTag = _xmlEl(xml, 'variables');
    if (xml.firstChild) xml.insertBefore(variablesTag, xml.firstChild);
    else xml.appendChild(variablesTag);
  }
  const varNode = _xmlEl(xml, 'variable');
  varNode.setAttribute('id', robotId);
  varNode.textContent = robotVar;
  variablesTag.appendChild(varNode);

  // Collect current top-level <block> children (stacks)
  const topBlocks = [];
  const kids = Array.prototype.slice.call(xml.childNodes);
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === 1 && n.tagName && n.tagName.toLowerCase() === 'block') {
      topBlocks.push(n);
    }
  }

  // Build setup_robot and prepend; chain first stack under it when present
  const setup = _xmlEl(xml, 'block');
  setup.setAttribute('type', 'setup_robot');
  const x0 = topBlocks[0] && topBlocks[0].getAttribute('x');
  const y0 = topBlocks[0] && topBlocks[0].getAttribute('y');
  if (x0 != null) setup.setAttribute('x', x0);
  if (y0 != null) {
    const yNum = parseFloat(y0);
    setup.setAttribute('y', String(isNaN(yNum) ? y0 : yNum - 40));
  } else {
    setup.setAttribute('x', '50');
    setup.setAttribute('y', '50');
  }

  const fVar = _xmlEl(xml, 'field');
  fVar.setAttribute('name', 'VARIABLE');
  fVar.setAttribute('id', robotId);
  fVar.textContent = robotVar;
  setup.appendChild(fVar);

  const fModel = _xmlEl(xml, 'field');
  fModel.setAttribute('name', 'MODEL');
  fModel.textContent = 'Mirobot_UART';
  setup.appendChild(fModel);

  // Old .blockly files have no serial port — leave unassigned so the import
  // dialog asks the user to pick one (do not pretend the file said VirtualMirobot).
  const fPort = _xmlEl(xml, 'field');
  fPort.setAttribute('name', 'PORT');
  fPort.textContent = LEGACY_PORT_PLACEHOLDER;
  setup.appendChild(fPort);

  if (topBlocks.length > 0) {
    const first = topBlocks[0];
    first.removeAttribute('x');
    first.removeAttribute('y');
    const next = _xmlEl(xml, 'next');
    // Move first stack under setup → next
    xml.removeChild(first);
    next.appendChild(first);
    setup.appendChild(next);
    if (xml.firstChild && xml.firstChild.tagName &&
        xml.firstChild.tagName.toLowerCase() === 'variables') {
      // insert setup after variables
      if (xml.firstChild.nextSibling) {
        xml.insertBefore(setup, xml.firstChild.nextSibling);
      } else {
        xml.appendChild(setup);
      }
    } else if (xml.firstChild) {
      xml.insertBefore(setup, xml.firstChild);
    } else {
      xml.appendChild(setup);
    }
  } else {
    xml.appendChild(setup);
  }

  return { robotVar: robotVar };
}

/**
 * Import blocks from an XML or legacy .blockly file.
 * Appends imported blocks to the current workspace (does not replace).
 * Legacy files are converted (setup_robot + mapped blocks) first.
 * One dialog maps variables and ports together.
 * Any unsupported block type aborts the whole import.
 */
function importBlocks() {
  const workspace = getWorkspace ? getWorkspace() : null;
  if (!workspace) return;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xml,.blockly,text/xml';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target.result;
        const xml = Blockly.utils.xml.textToDom(text);

        // Validate every <block type> before mutating
        const types = collectBlockTypesInXml(xml);
        const check = validateImportBlockTypes(types);
        if (!check.ok) {
          alert(
            'Import cancelled. Unsupported block type(s):\n\n' +
            check.unsupported.join(', ') +
            '\n\nNo blocks were imported.'
          );
          return;
        }

        if (xmlContainsLegacyBlocks(xml)) {
          convertLegacyBlocklyXml(xml, workspace);
        }

        // Only prompt for real workspace variables (not procedure parameters)
        const fileVars = collectImportedVariablesForDialog(xml);
        const portInfo = collectImportedSetupPorts(xml);

        if (fileVars.length === 0 && portInfo.portKeys.length === 0) {
          finishBlocklyImport(xml, workspace, null, {});
          return;
        }

        showBlocklyImportMappingDialog(
          fileVars,
          workspace,
          portInfo.portKeys,
          portInfo.portModelMap,
          function(result) {
            try {
              finishBlocklyImport(
                xml,
                workspace,
                result.portMapping,
                result.varChoices || {}
              );
            } catch (err) {
              alert('Error loading file: ' + err.message);
            }
          }
          // cancel → do nothing
        );
      } catch (err) {
        alert('Error loading file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

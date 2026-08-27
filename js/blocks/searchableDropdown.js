/**
 * Typeahead (quick-search) FieldDropdown for long option lists
 * (e.g. cv2 functions / constants).
 *
 * While the dropdown is open, typing characters jumps to the first option
 * whose *display label* starts with the typed buffer (case-sensitive).
 *
 * Buffer rules:
 *  - Append each printable character to the buffer.
 *  - Prefer a match for the full buffer (e.g. "co").
 *  - If none, fall back to matching just the last character (e.g. "o").
 *  - Buffer clears after 1s of idle typing, or when the menu closes.
 *  - Backspace trims the buffer.
 */

/**
 * Create a Blockly.FieldDropdown with typeahead jump-to typing.
 * @param {Array|Function} menuGenerator
 * @param {Function=} opt_validator
 * @returns {Blockly.FieldDropdown}
 */
function createTypeaheadDropdown(menuGenerator, opt_validator) {
  var field = new Blockly.FieldDropdown(menuGenerator, opt_validator);
  installTypeaheadOnDropdown(field);
  return field;
}

/**
 * Patch an existing FieldDropdown instance with typeahead behavior.
 * @param {Blockly.FieldDropdown} field
 */
function installTypeaheadOnDropdown(field) {
  if (!field || field._typeaheadInstalled) return;
  field._typeaheadInstalled = true;
  field._typeaheadBuffer = '';
  field._typeaheadTimer = null;
  field._typeaheadKeyHandler = null;

  var origShow = field.showEditor_.bind(field);
  var origDispose = field.dropdownDispose_
    ? field.dropdownDispose_.bind(field)
    : null;

  field.showEditor_ = function(e) {
    origShow(e);
    field._typeaheadBuffer = '';
    if (field._typeaheadTimer) {
      clearTimeout(field._typeaheadTimer);
      field._typeaheadTimer = null;
    }
    // Capture phase so we see keys before Blockly Menu handles them
    field._typeaheadKeyHandler = function(ev) {
      onTypeaheadKeyDown_(field, ev);
    };
    document.addEventListener('keydown', field._typeaheadKeyHandler, true);
  };

  field.dropdownDispose_ = function() {
    uninstallTypeaheadListeners_(field);
    if (origDispose) origDispose();
  };
}

function uninstallTypeaheadListeners_(field) {
  if (field._typeaheadKeyHandler) {
    document.removeEventListener('keydown', field._typeaheadKeyHandler, true);
    field._typeaheadKeyHandler = null;
  }
  if (field._typeaheadTimer) {
    clearTimeout(field._typeaheadTimer);
    field._typeaheadTimer = null;
  }
  field._typeaheadBuffer = '';
}

/**
 * @param {Blockly.FieldDropdown} field
 * @param {KeyboardEvent} e
 */
function onTypeaheadKeyDown_(field, e) {
  // Only while this field's menu is open
  if (!field.menu_) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // Navigation / accept keys — leave to Blockly
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
      e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab' ||
      e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' ||
      e.key === 'PageDown') {
    return;
  }

  if (e.key === 'Backspace') {
    if (!field._typeaheadBuffer) return;
    field._typeaheadBuffer = field._typeaheadBuffer.slice(0, -1);
    e.preventDefault();
    e.stopPropagation();
    bumpTypeaheadTimer_(field);
    if (field._typeaheadBuffer) {
      jumpTypeahead_(field, field._typeaheadBuffer);
    }
    return;
  }

  // Printable single character only (case-sensitive as typed)
  if (!e.key || e.key.length !== 1) return;

  var ch = e.key;
  var withChar = field._typeaheadBuffer + ch;
  var matched = jumpTypeahead_(field, withChar);
  if (matched) {
    field._typeaheadBuffer = withChar;
  } else {
    // Fall back to just the new character (e.g. no "co" → try "o")
    matched = jumpTypeahead_(field, ch);
    field._typeaheadBuffer = matched ? ch : withChar;
  }

  e.preventDefault();
  e.stopPropagation();
  bumpTypeaheadTimer_(field);
}

function bumpTypeaheadTimer_(field) {
  if (field._typeaheadTimer) clearTimeout(field._typeaheadTimer);
  field._typeaheadTimer = setTimeout(function() {
    field._typeaheadBuffer = '';
    field._typeaheadTimer = null;
  }, 1000);
}

/**
 * Find and highlight the first option whose display label starts with prefix
 * (case-sensitive). Also tries the short value suffix (after last '.').
 * @returns {boolean} true if a match was found
 */
function jumpTypeahead_(field, prefix) {
  if (!prefix || !field.menu_) return false;

  var options;
  try {
    options = field.getOptions(true);
  } catch (err) {
    return false;
  }
  if (!options || !options.length) return false;

  var matchValue = null;
  var matchLabel = null;
  for (var i = 0; i < options.length; i++) {
    var opt = options[i];
    if (!opt || opt === 'separator' || opt === Blockly.FieldDropdown.SEPARATOR) {
      continue;
    }
    var label = opt[0];
    var value = opt[1];
    if (typeof label !== 'string') {
      // Image / HTML options — fall back to value string
      label = String(value || '');
    }
    var shortVal = String(value || '').split('.').pop();
    if (label.startsWith(prefix) ||
        shortVal.startsWith(prefix) ||
        String(value || '').startsWith(prefix)) {
      matchValue = value;
      matchLabel = label;
      break;
    }
  }
  if (matchValue == null) return false;

  // Highlight matching menu item (keeps Enter/click behavior)
  var menu = field.menu_;
  var items = menu.menuItems || [];
  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    if (!item || typeof item.getValue !== 'function') continue;
    if (item.getValue() === matchValue) {
      if (typeof menu.setHighlighted === 'function') {
        menu.setHighlighted(item);
      }
      // Ensure visible even if setHighlighted path differs
      try {
        var el = item.getElement && item.getElement();
        if (el && el.scrollIntoView) {
          el.scrollIntoView({ block: 'nearest' });
        }
      } catch (eScroll) { /* ignore */ }
      return true;
    }
  }

  // Fallback: match by visible text in the DOM
  try {
    var root = menu.getElement && menu.getElement();
    if (root) {
      var nodes = root.querySelectorAll('.blocklyMenuItem');
      for (var k = 0; k < nodes.length; k++) {
        var text = (nodes[k].textContent || '').trim();
        if (text === matchLabel || text.startsWith(prefix)) {
          nodes[k].classList.add('blocklyMenuItemHighlight');
          nodes[k].scrollIntoView({ block: 'nearest' });
          // Clear others
          for (var m = 0; m < nodes.length; m++) {
            if (m !== k) nodes[m].classList.remove('blocklyMenuItemHighlight');
          }
          return true;
        }
      }
    }
  } catch (eDom) { /* ignore */ }

  return false;
}

// Expose for blocks
window.createTypeaheadDropdown = createTypeaheadDropdown;
window.installTypeaheadOnDropdown = installTypeaheadOnDropdown;

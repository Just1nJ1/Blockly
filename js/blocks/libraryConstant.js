/**
 * Library Constant Block
 * Value block with a dropdown of module-level constants (e.g. cv2.COLOR_BGR2GRAY)
 * populated when the user imports a library.
 */

function initLibraryConstantBlock() {
  Blockly.Blocks['library_constant'] = {
    init: function() {
      var dd = (typeof createTypeaheadDropdown === 'function')
        ? createTypeaheadDropdown([['...', '...']])
        : new Blockly.FieldDropdown([['...', '...']]);
      this.appendDummyInput('CONST_ROW')
          .appendField('const')
          .appendField(dd, 'CONST_NAME');

      this.setInputsInline(true);
      this.setOutput(true, null);
      this.setColour(160);
      this.setTooltip('Use a constant from an imported library (e.g. cv2.COLOR_BGR2GRAY). Type to jump in the list (case-sensitive).');
      this.setHelpUrl('');
    },

    mutationToDom: function() {
      var container = document.createElement('mutation');
      container.setAttribute('const_name', this.getFieldValue('CONST_NAME') || '...');
      var dropdown = this.getField('CONST_NAME');
      if (dropdown && dropdown.menuGenerator_) {
        var options = dropdown.menuGenerator_.map(function(opt) { return opt[1]; });
        container.setAttribute('options', JSON.stringify(options));
      }
      return container;
    },

    domToMutation: function(xmlElement) {
      var optionsStr = xmlElement.getAttribute('options');
      var constName = xmlElement.getAttribute('const_name');
      if (optionsStr) {
        try {
          this.updateOptions(JSON.parse(optionsStr));
        } catch (e) { /* ignore */ }
      }
      if (constName) {
        try {
          this.setFieldValue(constName, 'CONST_NAME');
        } catch (e2) { /* ignore */ }
      }
      this._refreshTooltip();
    },

    saveExtraState: function() {
      var dropdown = this.getField('CONST_NAME');
      return {
        const_name: this.getFieldValue('CONST_NAME') || '...',
        options: dropdown && dropdown.menuGenerator_
          ? dropdown.menuGenerator_.map(function(opt) { return opt[1]; })
          : []
      };
    },

    loadExtraState: function(state) {
      if (!state) return;
      if (state.options) {
        this.updateOptions(state.options);
      }
      if (state.const_name) {
        try {
          this.setFieldValue(state.const_name, 'CONST_NAME');
        } catch (e) { /* ignore */ }
      }
      this._refreshTooltip();
    },

    /**
     * @param {string[]} options - fully-qualified names, e.g. ["cv2.COLOR_BGR2GRAY"]
     */
    updateOptions: function(options) {
      var dropdown = this.getField('CONST_NAME');
      if (!dropdown) return;

      var list = Array.isArray(options) ? options.slice() : [];
      var menuOptions = list.map(function(opt) {
        // Show short name in menu, keep full name as value
        var short = String(opt).split('.').pop();
        return [short, opt];
      });
      if (menuOptions.length === 0) {
        menuOptions.push(['...', '...']);
      }
      if (typeof dropdown.setOptions === 'function') {
        dropdown.setOptions(menuOptions);
      } else {
        dropdown.menuGenerator_ = menuOptions;
      }
      if (typeof installTypeaheadOnDropdown === 'function') {
        installTypeaheadOnDropdown(dropdown);
      }

      var block = this;
      dropdown.setValidator(function(newValue) {
        block._refreshTooltip(newValue);
        return newValue;
      });

      // Keep current selection if still present; else first option
      var current = this.getFieldValue('CONST_NAME');
      var values = menuOptions.map(function(o) { return o[1]; });
      if (current && values.indexOf(current) >= 0) {
        try { dropdown.setValue(current); } catch (e) { /* ignore */ }
      } else {
        try { dropdown.setValue(menuOptions[0][1]); } catch (e2) { /* ignore */ }
      }
      this._refreshTooltip();
    },

    _refreshTooltip: function(name) {
      var n = name || this.getFieldValue('CONST_NAME') || '';
      if (!n || n === '...') {
        this.setTooltip('Use a constant from an imported library.');
      } else {
        this.setTooltip('Constant: ' + n);
      }
    }
  };
}

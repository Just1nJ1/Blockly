/**
 * Workflow template registry — loads core (and later extension) templates.
 */
(function() {
  'use strict';

  var templatesById = {};
  var loadPromise = null;

  function getAll() {
    var list = [];
    for (var id in templatesById) {
      if (Object.prototype.hasOwnProperty.call(templatesById, id)) {
        list.push(templatesById[id]);
      }
    }
    list.sort(function(a, b) {
      return (a.name || a.id).localeCompare(b.name || b.id);
    });
    return list;
  }

  function getById(id) {
    return templatesById[id] || null;
  }

  function register(template, source) {
    if (!template || !template.id) return false;
    var result = window.WorkflowSchema
      ? window.WorkflowSchema.validate(template)
      : { ok: true, errors: [] };
    if (!result.ok) {
      console.error('[Workflows] Invalid template', template.id, result.errors);
      return false;
    }
    template._source = source || 'core';
    templatesById[template.id] = template;
    return true;
  }

  function unregister(id) {
    delete templatesById[id];
  }

  /**
   * Load core templates listed in workflows/index.json.
   * Safe to call multiple times — returns the same promise while in flight.
   */
  function loadCore() {
    if (loadPromise) return loadPromise;

    loadPromise = fetch('./workflows/index.json')
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(index) {
        var files = (index && index.templates) || [];
        return Promise.all(files.map(function(file) {
          return fetch('./workflows/' + file)
            .then(function(r) {
              if (!r.ok) throw new Error(file + ' HTTP ' + r.status);
              return r.json();
            })
            .then(function(tpl) {
              register(tpl, 'core');
            })
            .catch(function(err) {
              console.error('[Workflows] Failed to load', file, err);
            });
        }));
      })
      .then(function() {
        console.log('[Workflows] Loaded', getAll().length, 'template(s):',
          getAll().map(function(t) { return t.id; }));
        return getAll();
      })
      .catch(function(err) {
        console.error('[Workflows] Failed to load index:', err);
        loadPromise = null;
        return [];
      });

    return loadPromise;
  }

  /**
   * Register a template from an extension (or tests).
   */
  function registerExternal(template, source) {
    return register(template, source || 'extension');
  }

  window.WorkflowRegistry = {
    loadCore: loadCore,
    getAll: getAll,
    getById: getById,
    register: registerExternal,
    unregister: unregister
  };
})();

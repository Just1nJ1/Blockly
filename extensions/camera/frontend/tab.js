(function () {
  var statusEl = document.getElementById('camera-ext-status');

  function show(text) {
    if (statusEl) statusEl.textContent = text;
  }

  if (!window.ExtensionAPI || typeof ExtensionAPI.fetch !== 'function') {
    show('Extension API is not available.');
    return;
  }

  ExtensionAPI.fetch('camera', '/status').then(function (data) {
    if (data && data.success) {
      show('OpenCV ' + (data.opencv || '') + ' is available to dependent extensions.');
    } else {
      show((data && data.error) || 'OpenCV is not installed yet. Install the camera extension packages.');
    }
  }).catch(function () {
    show('Could not reach the camera extension backend.');
  });
})();

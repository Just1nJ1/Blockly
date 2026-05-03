(function () {
  var stepInput = document.getElementById('sample-step');
  var statusEl  = document.getElementById('sample-status');

  function jogX(direction) {
    var step = parseFloat(stepInput.value) || 5;
    if (direction < 0) step = -step;

    statusEl.textContent = 'Moving ' + (step > 0 ? '+' : '') + step + ' mm …';

    ExtensionAPI.fetch('sample', '/jog-all-x', {
      method: 'POST',
      body: JSON.stringify({ step: step })
    })
      .then(function (data) {
        if (!data.success) {
          statusEl.textContent = 'Error: ' + (data.error || 'unknown');
          return;
        }
        var ok = 0, fail = 0;
        (data.results || []).forEach(function (r) { r.success ? ok++ : fail++; });
        statusEl.textContent = ok + ' arm(s) moved' + (fail ? ', ' + fail + ' failed' : '');
      })
      .catch(function (err) {
        statusEl.textContent = 'Error: ' + err.message;
      });
  }

  document.getElementById('sample-forward').addEventListener('click', function () { jogX(1); });
  document.getElementById('sample-back').addEventListener('click', function () { jogX(-1); });

  // Keyboard arrows while this tab is visible
  document.addEventListener('keydown', function (e) {
    var view = document.getElementById('sample-view');
    if (!view || !view.classList.contains('active')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); jogX(1); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); jogX(-1); }
  });
})();
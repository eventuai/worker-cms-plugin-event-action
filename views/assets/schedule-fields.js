// Progressive enhancement for the repeat-schedule fields: only the inputs the
// selected repeat actually uses stay visible (time for daily/weekly/monthly,
// weekday for weekly, day-of-month for monthly; none for manual or fixed
// intervals). Without this script all fields show — harmless, just noisier.
// Hidden fields still submit their values; the engine ignores what the chosen
// repeat doesn't use.
(function () {
  'use strict';

  var repeat = document.querySelector('[data-schedule-repeat]');
  if (!repeat) return;

  var FIELDS = {
    daily: ['time'],
    weekly: ['time', 'weekday'],
    monthly: ['time', 'monthday'],
  };

  function sync() {
    var visible = FIELDS[repeat.value] || [];
    document.querySelectorAll('[data-schedule-field]').forEach(function (field) {
      field.hidden = visible.indexOf(field.getAttribute('data-schedule-field')) === -1;
    });
  }

  repeat.addEventListener('change', sync);
  sync();
}());

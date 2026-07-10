// Progressive enhancement for the guest-filter editor: unhides the
// server-rendered "Add rule" / per-row remove buttons and wires them up.
// Without this script the form still works — a blank row is appended on every
// save, as the only way to type in a new rule. Rows are positional
// (filter_field/filter_op/filter_value arrays), so whole-row removal keeps
// the three arrays aligned.
(function () {
  'use strict';

  var container = document.querySelector('[data-filter-rows]');
  var addButton = document.querySelector('[data-filter-add]');
  if (!container || !addButton) return;

  var rows = container.querySelectorAll('[data-filter-row]');
  if (!rows.length) return;

  function fieldValue(row) {
    var field = row.querySelector('input[name="filter_field"]');
    return field ? field.value.trim() : '';
  }

  function clearRow(row) {
    row.querySelectorAll('input').forEach(function (input) { input.value = ''; });
    row.querySelectorAll('select').forEach(function (select) { select.selectedIndex = 0; });
  }

  // Blank template cloned from the last row (the server always appends one
  // blank row as a no-JS fallback to type into) before it's pruned below.
  // The first row carries the column labels — strip them from clones.
  var template = rows[rows.length - 1].cloneNode(true);
  template.querySelectorAll('[data-filter-label]').forEach(function (label) { label.remove(); });
  clearRow(template);

  // With "Add rule" available, that guaranteed trailing blank row is
  // redundant once at least one real rule already exists — drop it so a save
  // doesn't leave a stray empty condition behind. Keep it when it's the only
  // row: the editor always needs at least one row to type into.
  if (rows.length > 1 && !fieldValue(rows[rows.length - 1])) {
    rows[rows.length - 1].remove();
    rows = container.querySelectorAll('[data-filter-row]');
  }

  // A lone row cannot be removed — its Remove button stays hidden so the
  // editor always keeps at least one row to type into.
  function syncRemoveButtons() {
    var lone = container.querySelectorAll('[data-filter-row]').length === 1;
    container.querySelectorAll('[data-filter-remove]').forEach(function (button) {
      button.hidden = lone;
    });
  }

  function activate(row) {
    row.querySelectorAll('[data-filter-remove]').forEach(function (button) {
      button.addEventListener('click', function () {
        row.remove();
        syncRemoveButtons();
      });
    });
  }

  function addRow() {
    var row = template.cloneNode(true);
    container.appendChild(row);
    activate(row);
    syncRemoveButtons();
  }

  addButton.hidden = false;
  addButton.addEventListener('click', addRow);
  rows.forEach(activate);
  syncRemoveButtons();
}());

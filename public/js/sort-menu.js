// The sort menu: one button that opens two groups of choices, what to sort by and
// which way round. Built from plain radio buttons, so arrow keys, Tab and screen
// readers behave as they do in any form.

import { SORTS } from './filter.js';

const DATES = { desc: 'Newest first', asc: 'Oldest first' };
const ALPHABETICAL = { asc: 'A–Z', desc: 'Z–A' };
/** The two directions read differently for dates and for titles. */
const ORDER_LABELS = { created: DATES, updated: DATES, title: ALPHABETICAL };

/** Pointer picks close the menu once the new choice has been seen to take. */
const CLOSE_AFTER_PICK_MS = 150;

export function createSortMenu({ root, onChange }) {
  const button = root.querySelector('.sort-button');
  const menu = root.querySelector('.sort-menu');
  const current = root.querySelector('.sort-current');
  const orderGroup = root.querySelector('.sort-orders');
  const input = (name, value) => menu.querySelector(`input[name="${name}"][value="${value}"]`);
  const orderOptions = { asc: input('order', 'asc').closest('.sort-option'), desc: input('order', 'desc').closest('.sort-option') };

  const isOpen = () => !menu.hidden;

  function open() {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('input[name="sort"]:checked')?.focus({ preventScroll: true });
  }

  function close({ restoreFocus = false } = {}) {
    if (!isOpen()) return;
    const hadFocus = menu.contains(document.activeElement);
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus || hadFocus) button.focus({ preventScroll: true });
  }

  /** Shows `{ sort, order }`: ticks, the direction labels for this sort, and the button's summary. */
  function sync({ sort, order }) {
    const sortInput = input('sort', sort);
    sortInput.checked = true;

    const labels = ORDER_LABELS[sort];
    for (const key of Object.keys(orderOptions)) orderOptions[key].querySelector('span').textContent = labels[key];
    // The expected direction goes first, so arrow keys move the way the list reads.
    const [first, second] = SORTS[sort].natural === 'desc' ? [orderOptions.desc, orderOptions.asc] : [orderOptions.asc, orderOptions.desc];
    if (orderGroup.querySelector('.sort-option') !== first) orderGroup.append(first, second);
    input('order', order).checked = true;

    const name = sortInput.nextElementSibling.textContent;
    current.textContent = name;
    button.dataset.order = order;
    button.setAttribute('aria-label', `Sort: ${name}, ${labels[order]}`);
  }

  button.addEventListener('click', () => (isOpen() ? close() : open()));

  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!isOpen()) open();
  });

  menu.addEventListener('change', (event) => {
    const sort = event.target.name === 'sort' ? event.target.value : menu.querySelector('input[name="sort"]:checked').value;
    // Choosing a different sort starts from the direction people expect for it.
    onChange({ sort, order: event.target.name === 'order' ? event.target.value : SORTS[sort].natural });
  });

  menu.addEventListener('pointerup', (event) => {
    if (event.target.closest('.sort-option')) setTimeout(() => close({ restoreFocus: true }), CLOSE_AFTER_PICK_MS);
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen()) return;
    event.preventDefault();
    close({ restoreFocus: true });
  });

  root.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !root.contains(event.relatedTarget)) close();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target)) close();
  });

  return { sync };
}

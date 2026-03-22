/**
 * toast.js — トースト通知モジュール
 */

import { escHtml } from './dom-utils.js';

/**
 * トーストを表示する
 * @param {string} message
 * @param {string} type - 'info' | 'success' | 'error'
 * @param {{persistent?: boolean, spinner?: boolean}} options
 * @returns {HTMLElement} トースト要素
 */
export function showToast(message, type = 'info', options = {}) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  if (options.spinner) {
    toast.innerHTML = `<span class="toast-spinner"></span><span>${escHtml(message)}</span>`;
  } else {
    toast.textContent = message;
  }
  if (!container) return toast;
  container.appendChild(toast);
  if (!options.persistent) {
    setTimeout(() => toast.remove(), 3000);
  }
  return toast;
}

/** persistentトーストを消去する */
export function dismissToast(toastEl) {
  if (toastEl && toastEl.parentElement) toastEl.remove();
}

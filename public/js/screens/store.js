import { api } from '../api.js';
import { buddySvg, cosmeticIcon } from '../buddy.js';
import { escapeHtml, fmt, toast } from '../fx.js';
import { app } from '../state.js';
import { pointIcon } from './home.js';

const SLOT_LABELS = { hat: 'Hats', eyewear: 'Eyewear', accessory: 'Accessories', background: 'Backgrounds' };
const coinIcon = '<span class="coin-icon" aria-hidden="true">C</span>';

export function mount(el) {
  let view = 'store';
  let items = null;
  let coinPackages = null;
  let busy = false;

  function storeHtml() {
    const { points } = app.state.user;
    return `<div class="grid">${items.map((item) => `
      <article class="item ${item.owned ? 'is-owned' : ''}">
        <div class="item-art">${cosmeticIcon(item)}${item.owned
          ? '<span class="stamp">Owned</span>'
          : `<span class="price-tag">${pointIcon}${fmt(item.price)}</span>`}</div>
        <b>${escapeHtml(item.name)}</b>
        ${item.owned
          ? '<span class="owned">In your wardrobe</span>'
          : `<button class="btn btn-small ${points < item.price ? 'is-short' : 'btn-primary'}"
              data-buy="${item.id}" aria-label="Buy ${escapeHtml(item.name)} for ${item.price} points">
              ${points < item.price ? `Need ${fmt(item.price - points)}` : 'Buy'}</button>`}
      </article>`).join('')}</div>`;
  }

  function wardrobeHtml() {
    const { buddy } = app.state;
    const owned = items.filter((item) => item.owned);
    const slots = Object.entries(SLOT_LABELS).map(([slot, label]) => {
      const inSlot = owned.filter((item) => item.slot === slot);
      if (!inSlot.length) return '';
      return `
        <h3>${label}</h3>
        <div class="grid grid-3">${inSlot.map((item) => {
          const on = buddy.equipped[slot] === item.id;
          return `
            <button class="item item-tap ${on ? 'is-equipped' : ''}" data-equip="${item.id}" data-slot="${slot}"
              aria-pressed="${on}">
              <div class="item-art">${cosmeticIcon(item)}</div>
              <b>${escapeHtml(item.name)}</b>
              <span class="owned">${on ? 'Wearing' : 'Tap to wear'}</span>
            </button>`;
        }).join('')}</div>`;
    }).join('');
    return `
      <div class="preview">${buddySvg(buddy, { className: 'is-idle' })}</div>
      ${slots || '<p class="empty">Your wardrobe is empty. Buy something in the Store!</p>'}`;
  }

  function coinsHtml() {
    return `
      <section class="coin-hero">
        <div class="coin-balance">${coinIcon}<span><small>Your coin balance</small><b>${fmt(app.state.user.coins)}</b></span></div>
        <p>Use coins for special offers and future upgrades. This demo purchase adds coins instantly.</p>
      </section>
      <div class="coin-grid">${coinPackages.map((pack) => `
        <article class="coin-pack ${pack.popular ? 'is-popular' : ''}">
          ${pack.popular ? '<span class="popular">Best value</span>' : ''}
          <div class="coin-pack-art">${coinIcon}</div>
          <b>${escapeHtml(pack.name)}</b>
          <strong>${fmt(pack.coins)} coins</strong>
          <button class="btn btn-primary" data-buy-coins="${pack.id}">$${(pack.priceCents / 100).toFixed(2)} · Add coins</button>
        </article>`).join('')}</div>`;
  }

  function render() {
    el.innerHTML = `
      <header class="topbar">
        <h1>${view === 'store' ? 'Store' : 'Wardrobe'}</h1>
        <div class="balance" aria-label="${app.state.user.points} Stride Points">${pointIcon}<b>${fmt(app.state.user.points)}</b></div>
      </header>
      <div class="segmented" role="tablist">
        <button role="tab" aria-selected="${view === 'store'}" data-view="store">Store</button>
        <button role="tab" aria-selected="${view === 'coins'}" data-view="coins">Buy Coins</button>
        <button role="tab" aria-selected="${view === 'wardrobe'}" data-view="wardrobe">Wardrobe</button>
      </div>
      ${items === null || coinPackages === null ? '<p class="empty">Loading…</p>' : view === 'store' ? storeHtml() : view === 'coins' ? coinsHtml() : wardrobeHtml()}`;
  }

  async function buy(id) {
    const item = items.find((i) => i.id === id);
    const { points } = app.state.user;
    if (points < item.price) {
      toast(`You need ${fmt(item.price - points)} more Stride Points.`, 'warn');
      return;
    }
    const result = await api('/store/buy', { method: 'POST', body: { itemId: id } });
    items = result.items;
    app.setState(result);
    toast(`${item.name} is yours! Find it in your Wardrobe.`, 'good');
  }

  async function equip(id, slot) {
    const wearing = app.state.buddy.equipped[slot] === id;
    app.setState(await api('/buddy/equip', { method: 'POST', body: { slot, itemId: wearing ? null : id } }));
  }

  async function buyCoins(id) {
    const result = await api('/store/buy-coins', { method: 'POST', body: { packageId: id } });
    app.setState(result);
    toast(`${fmt(result.purchased.coins)} coins added to your wallet!`, 'good');
  }

  const onClick = async (event) => {
    const tab = event.target.closest('[data-view]');
    if (tab) {
      view = tab.dataset.view;
      return render();
    }
    const buyBtn = event.target.closest('[data-buy]');
    const equipBtn = event.target.closest('[data-equip]');
    const coinsBtn = event.target.closest('[data-buy-coins]');
    if ((!buyBtn && !equipBtn && !coinsBtn) || busy) return;
    busy = true;
    try {
      if (buyBtn) await buy(buyBtn.dataset.buy);
      else if (coinsBtn) await buyCoins(coinsBtn.dataset.buyCoins);
      else await equip(equipBtn.dataset.equip, equipBtn.dataset.slot);
    } catch (err) {
      toast(err.message, 'warn');
    } finally {
      busy = false;
    }
  };
  el.addEventListener('click', onClick);
  render();
  api('/store')
    .then((data) => {
      items = data.items;
      coinPackages = data.coinPackages;
      render();
    })
    .catch((err) => toast(err.message, 'warn'));

  return { update: render, destroy: () => el.removeEventListener('click', onClick) };
}

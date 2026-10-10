import { api } from '../api.js';
import { SPECIES, buddySvg, cosmeticIcon, stageName } from '../buddy.js';
import { escapeHtml, fmt, toast } from '../fx.js';
import { app } from '../state.js';
import { pointIcon } from './home.js';

const SLOT_LABELS = { hat: 'Hats', eyewear: 'Eyewear', accessory: 'Accessories', background: 'Backgrounds' };
const diamondIcon = '<span class="coin-icon diamond-icon" aria-hidden="true">💎</span>';

const DEFAULT_DIAMOND_PACKAGES = [
  { id: 'diamonds_50', name: 'Handful of Diamonds', diamonds: 50, priceCents: 99, popular: false },
  { id: 'diamonds_300', name: 'Diamond Pouch', diamonds: 300, priceCents: 499, popular: true },
  { id: 'diamonds_750', name: 'Diamond Vault', diamonds: 750, priceCents: 999, popular: false },
];

const VIEW_TITLES = { store: 'Store', diamonds: 'Diamonds', wardrobe: 'Wardrobe', beasts: 'Beasts' };

export function mount(el) {
  let view = 'store';
  let items = null;
  let eggs = null;
  let diamondPackages = null;
  let busy = false;

  // Common and uncommon eggs cost Stride Points; rare and legendary ones cost diamonds.
  function eggsHtml() {
    return `<div class="grid">${eggs.map((egg) => {
      const paidInDiamonds = egg.currency === 'diamonds';
      const balance = paidInDiamonds ? app.diamonds : app.state.user.points;
      const icon = paidInDiamonds ? diamondIcon : pointIcon;
      const name = SPECIES[egg.species].titles.egg;
      return `
      <article class="item ${egg.owned ? 'is-owned' : ''}">
        <div class="item-art">${buddySvg({ species: egg.species, stage: 'egg' }, { background: false })}${egg.owned
          ? '<span class="stamp">Owned</span>'
          : `<span class="price-tag">${icon}${fmt(egg.price)}</span>`}</div>
        <b>${name}</b>
        <span class="rarity" data-rarity="${egg.rarity}">${egg.rarity}</span>${egg.owned
          ? '<span class="owned">With your beasts</span>'
          : `<button class="btn btn-small ${balance < egg.price ? 'is-short' : 'btn-primary'}"
              data-buy-egg="${egg.species}" aria-label="Buy ${name} for ${egg.price} ${paidInDiamonds ? 'diamonds' : 'points'}">
              ${balance < egg.price ? `Need ${fmt(egg.price - balance)}` : 'Buy'}</button>`}
      </article>`;
    }).join('')}</div>`;
  }

  function beastsHtml() {
    const { buddy, resting } = app.state;
    const tile = (beast, walking) => `
      <button class="item item-tap ${walking ? 'is-equipped' : ''}" ${walking ? 'disabled' : `data-switch="${beast.id}"`}
        aria-pressed="${walking}">
        <div class="item-art">${buddySvg(beast, { background: false })}</div>
        <b>${escapeHtml(beast.name)}</b>
        <span class="owned">${stageName(beast)} · Lv ${beast.level}</span>
        <span class="owned">${walking ? 'Walking with you' : 'Tap to walk with'}</span>
      </button>`;
    return `
      <div class="grid">${tile(buddy, true)}${resting.map((beast) => tile(beast, false)).join('')}</div>
      ${resting.length ? '' : '<p class="empty">Buy an egg in the Store to raise another beast.</p>'}`;
  }

  function storeHtml() {
    const { points } = app.state.user;
    return `<h3>Eggs</h3>${eggsHtml()}<h3>Cosmetics</h3><div class="grid">${items.map((item) => `
      <article class="item ${item.owned ? 'is-owned' : ''}">
        <div class="item-art">${cosmeticIcon(item)}${item.owned
          ? '<span class="stamp">Owned</span>'
          : `<span class="price-tag">${pointIcon}${fmt(item.price)}</span>`}</div>
        <b>${escapeHtml(item.name)}</b>${item.owned
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

  function diamondsHtml() {
    const currentDiamonds = app.diamonds;
    return `
      <section class="coin-hero diamond-hero">
        <div class="coin-balance diamond-balance">${diamondIcon}<span><small>Your diamond balance</small><b>${fmt(currentDiamonds)}</b></span></div>
        <p>Use diamonds for special offers and future upgrades. This demo purchase adds diamonds instantly.</p>
      </section>
      <div class="coin-grid diamond-grid">${diamondPackages.map((pack) => {
        const amount = pack.diamonds ?? pack.coins ?? 0;
        return `
        <article class="coin-pack diamond-pack ${pack.popular ? 'is-popular' : ''}">
          ${pack.popular ? '<span class="popular">Best value</span>' : ''}
          <div class="coin-pack-art diamond-pack-art">${diamondIcon}</div>
          <b>${escapeHtml(pack.name)}</b>
          <strong>${fmt(amount)} diamonds</strong>
          <button class="btn btn-primary" data-buy-diamonds="${pack.id}">$${(pack.priceCents / 100).toFixed(2)} · Add diamonds</button>
        </article>`;
      }).join('')}</div>`;
  }

  function render() {
    if (!app.state?.user) return;
    const title = VIEW_TITLES[view];
    const html = { store: storeHtml, diamonds: diamondsHtml, wardrobe: wardrobeHtml, beasts: beastsHtml };
    el.innerHTML = `
      <header class="topbar">
        <h1>${title}</h1>
        <div class="balance" aria-label="${app.state.user.points} Stride Points">${pointIcon}<b>${fmt(app.state.user.points)}</b></div>
      </header>
      <div class="segmented" role="tablist">
        <button role="tab" aria-selected="${view === 'store'}" data-view="store">Store</button>
        <button role="tab" aria-selected="${view === 'diamonds'}" data-view="diamonds">Diamonds</button>
        <button role="tab" aria-selected="${view === 'wardrobe'}" data-view="wardrobe">Wardrobe</button>
        <button role="tab" aria-selected="${view === 'beasts'}" data-view="beasts">Beasts</button>
      </div>
      ${items === null || diamondPackages === null ? '<p class="empty">Loading…</p>' : html[view]()}`;
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

  async function buyEgg(species) {
    const egg = eggs.find((e) => e.species === species);
    const paidInDiamonds = egg.currency === 'diamonds';
    const balance = paidInDiamonds ? app.diamonds : app.state.user.points;
    if (balance < egg.price) {
      toast(`You need ${fmt(egg.price - balance)} more ${paidInDiamonds ? 'diamonds' : 'Stride Points'}.`, 'warn');
      return;
    }
    const result = await api('/store/buy-egg', { method: 'POST', body: { species } });
    eggs = result.eggs;
    app.setState(result);
    toast(`${SPECIES[species].titles.egg} is yours! Find it under Beasts.`, 'good');
  }

  async function switchBeast(id) {
    app.setState(await api('/buddy/switch', { method: 'POST', body: { id } }));
    toast(`${app.state.buddy.name} is walking with you now.`, 'good');
  }

  async function equip(id, slot) {
    const wearing = app.state.buddy.equipped[slot] === id;
    app.setState(await api('/buddy/equip', { method: 'POST', body: { slot, itemId: wearing ? null : id } }));
  }

  async function buyDiamonds(id) {
    const pack = diamondPackages.find((p) => p.id === id);
    const amount = pack?.diamonds ?? pack?.coins ?? 0;
    try {
      let result;
      try {
        result = await api('/store/buy-diamonds', { method: 'POST', body: { packageId: id } });
      } catch {
        // Fallback in case backend route is still /store/buy-coins
        result = await api('/store/buy-coins', { method: 'POST', body: { packageId: id } });
      }
      app.setState(result);
      const added = result?.purchased?.diamonds ?? result?.purchased?.coins ?? amount;
      toast(`${fmt(added)} diamonds added to your wallet!`, 'good');
    } catch {
      // Local/demo fallback
      if (pack) {
        app.addDiamonds(amount);
        toast(`${fmt(amount)} diamonds added to your wallet!`, 'good');
      }
    }
  }

  const onClick = async (event) => {
    const tab = event.target.closest('[data-view]');
    if (tab) {
      view = tab.dataset.view;
      return render();
    }
    const buyBtn = event.target.closest('[data-buy]');
    const eggBtn = event.target.closest('[data-buy-egg]');
    const switchBtn = event.target.closest('[data-switch]');
    const equipBtn = event.target.closest('[data-equip]');
    const diamondsBtn = event.target.closest('[data-buy-diamonds]');
    if ((!buyBtn && !eggBtn && !switchBtn && !equipBtn && !diamondsBtn) || busy) return;
    busy = true;
    try {
      if (buyBtn) await buy(buyBtn.dataset.buy);
      else if (eggBtn) await buyEgg(eggBtn.dataset.buyEgg);
      else if (switchBtn) await switchBeast(Number(switchBtn.dataset.switch));
      else if (diamondsBtn) await buyDiamonds(diamondsBtn.dataset.buyDiamonds);
      else await equip(equipBtn.dataset.equip, equipBtn.dataset.slot);
    } catch (err) {
      toast(err.message, 'warn');
    } finally {
      busy = false;
    }
  };

  const onStateChange = () => render();

  el.addEventListener('click', onClick);
  app.addEventListener('change', onStateChange);
  render();

  api('/store')
    .then((data) => {
      items = data.items || [];
      eggs = data.eggs || [];
      const rawPackages = data.diamondPackages || data.coinPackages || DEFAULT_DIAMOND_PACKAGES;
      diamondPackages = rawPackages.map((p) => ({
        ...p,
        name: p.name.replace(/coins?/gi, 'Diamonds'),
        diamonds: p.diamonds ?? p.coins ?? 0,
      }));
      render();
    })
    .catch((err) => {
      items = items || [];
      eggs = eggs || [];
      diamondPackages = DEFAULT_DIAMOND_PACKAGES;
      render();
      toast(err.message, 'warn');
    });

  return {
    update: render,
    destroy: () => {
      el.removeEventListener('click', onClick);
      app.removeEventListener('change', onStateChange);
    },
  };
}
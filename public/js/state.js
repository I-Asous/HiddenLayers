import { api } from './api.js';
import { walk } from './steps.js';

class App extends EventTarget {
  /** Latest server state: { user, buddy, todaySteps, record }. Null when signed out. */
  state = null;
  demo = new URLSearchParams(location.search).get('demo') === '1';
  /** Something the buddy said out loud; shown in the Home speech bubble for a while. */
  spoken = null;

  /** Accepts any API response and keeps the state fields it carries. */
  setState(data) {
    if (!data?.user) return;
    this.state = {
      user: data.user, buddy: data.buddy, todaySteps: data.todaySteps, record: data.record,
    };
    this.dispatchEvent(new Event('change'));
  }

  clear() {
    this.state = null;
    this.spoken = null;
  }

  async refresh() {
    this.setState(await api('/me'));
  }

  /** Today's steps including the ones not yet confirmed by the server. */
  get todaySteps() {
    return (this.state?.todaySteps ?? 0) + walk.unsynced;
  }

  say(text) {
    if (!text) return;
    // Cleared when the voice finishes (see home); the time limit is a backstop
    // for when no voice plays. The ElevenLabs audio can lag the text by seconds.
    this.spoken = { text, until: Date.now() + 20_000 };
    this.dispatchEvent(new Event('change'));
  }
}

export const app = new App();
walk.onServerState((state) => app.setState(state));

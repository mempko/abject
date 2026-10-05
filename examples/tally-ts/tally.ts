import type { AbjectHandlers, AbjectMessage, PackageSettings } from '../../sdk/script/abject';

/** What this object keeps in this.data (saved across restarts). */
interface State {
  counts: Record<string, number>;
}

/** The settings abject.json declares, entered in Settings → Packages. */
interface Settings {
  unit: string;
  step: number;
  announce: boolean;
}

({
  /** Count `by` occurrences of `name` (the Step setting when `by` is omitted). */
  async add(msg: AbjectMessage<{ name: string; by?: number }>) {
    const { name, by } = msg.payload ?? {};
    this.ensure(typeof name === 'string' && name !== '', 'add needs a non-empty name');
    const settings = await this._settings();
    const step = by ?? settings.step ?? 1;
    this.ensure(Number.isFinite(step), 'by must be a number');

    const counts = { ...(this.data.counts ?? {}) };
    counts[name] = (counts[name] ?? 0) + step;
    this.data.counts = counts;
    await this.saveData();

    if (settings.announce) this.changed('counted', { name, count: counts[name] });
    return { name, count: counts[name], unit: settings.unit ?? 'visits' };
  },

  /** Every count so far, with the unit they are counted in. */
  async counts() {
    const settings = await this._settings();
    return { unit: settings.unit ?? 'visits', counts: { ...(this.data.counts ?? {}) } };
  },

  /** Clear one count, or all of them when no name is given. */
  async reset(msg: AbjectMessage<{ name?: string }>) {
    const name = msg.payload?.name;
    const counts = { ...(this.data.counts ?? {}) };
    if (name) delete counts[name];
    this.data.counts = name ? counts : {};
    await this.saveData();
    return { counts: { ...this.data.counts } };
  },

  /**
   * This package's settings. Packages answers getSettings only to abjects
   * spawned from an installed package; the defaults apply when it is absent.
   */
  async _settings(): Promise<Partial<Settings>> {
    try {
      const reply = await this.call<PackageSettings<Settings>>(this.dep('Packages'), 'getSettings', {});
      return reply.values;
    } catch {
      return {};
    }
  },
}) satisfies AbjectHandlers<State>;

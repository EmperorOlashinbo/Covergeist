import type { LanguageAdapter } from './LanguageAdapter';

export class AdapterRegistry {
  private readonly adapters: LanguageAdapter[] = [];

  register(adapter: LanguageAdapter): void {
    this.adapters.push(adapter);
  }

  async resolve(projectRoot: string): Promise<LanguageAdapter | null> {
    for (const adapter of this.adapters) {
      if (await adapter.canHandle(projectRoot)) {
        return adapter;
      }
    }
    return null;
  }
}

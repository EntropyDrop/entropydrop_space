/** All backpack formats that the current reader can restore. */
export const INVENTORY_STORAGE_KEY = 'space.backpack.v10.pb';
export const PREVIOUS_INVENTORY_STORAGE_KEY = 'space.backpack.v9.pb';
export const LEGACY_INVENTORY_STORAGE_KEY = 'space.backpack.v8.pb';
export const INVENTORY_STORAGE_KEYS = [
  INVENTORY_STORAGE_KEY, PREVIOUS_INVENTORY_STORAGE_KEY, LEGACY_INVENTORY_STORAGE_KEY,
] as const;

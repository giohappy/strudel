import { invoke, isTauri as isTauriCore } from '@tauri-apps/api/core';

export const Invoke = invoke;
export const isTauri = () => isTauriCore();

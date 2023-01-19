import { inject } from 'vue';
import type { AxiosInstance } from 'axios';
import { API_INJECT, EXTENSIONS_INJECT, STORES_INJECT, WEBSOCKET_INJECT } from '../constants/index.js';
import type { AppExtensionConfigs, WebSocketWrapper } from '../types/index.js';

export function useStores(): Record<string, any> {
	const stores = inject<Record<string, any>>(STORES_INJECT);

	if (!stores) throw new Error('[useStores]: The stores could not be found.');

	return stores;
}

export function getWebSocket(): WebSocketWrapper {
	const websocket = inject<() => WebSocketWrapper>(WEBSOCKET_INJECT);

	if (!websocket || typeof websocket !== 'function') {
		throw new Error('[getWebSocket]: The websocket could not be found.');
	}

	return websocket();
}

export function useApi(): AxiosInstance {
	const api = inject<AxiosInstance>(API_INJECT);

	if (!api) throw new Error('[useApi]: The api could not be found.');

	return api;
}

export function useExtensions(): AppExtensionConfigs {
	const extensions = inject<AppExtensionConfigs>(EXTENSIONS_INJECT);

	if (!extensions) throw new Error('[useExtensions]: The extensions could not be found.');

	return extensions;
}

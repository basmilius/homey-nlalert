import { Shortcuts } from '@basmilius/homey-common';
import type { NlAlert, NlAlertApiResponse, NlAlertApp } from './types';
import { Triggers } from './flow';

const API_URL = 'https://api.public-warning.app/api/v1/providers/nl-alert/alerts';
const POLL_INTERVAL_MS = 60_000;
const SETTINGS_KEY = 'knownAlertIds';

/**
 * Service that polls the NL Alert API and fires triggers when new alerts affect the Homey's location.
 */
export default class NlAlertService extends Shortcuts<NlAlertApp> {
    #knownAlertIds: Set<string> = new Set();
    #activeAlerts: NlAlert[] = [];
    #pollInterval: NodeJS.Timeout | null = null;

    /**
     * Returns the currently active NL Alerts that affect the Homey's location.
     */
    get activeAlerts(): NlAlert[] {
        return this.#activeAlerts;
    }

    /**
     * Starts the polling interval and performs an initial poll.
     */
    async initialize(): Promise<void> {
        this.#knownAlertIds = new Set(this.settings.get(SETTINGS_KEY) ?? []);
        await this.#poll();
        this.#pollInterval = this.setInterval(() => this.#poll(), POLL_INTERVAL_MS);
        this.log('NL Alert service started, polling every 60 seconds.');
    }

    /**
     * Stops the polling interval.
     */
    async destroy(): Promise<void> {
        if (this.#pollInterval !== null) {
            this.clearInterval(this.#pollInterval);
            this.#pollInterval = null;
        }
    }

    async #poll(): Promise<void> {
        try {
            const lat = this.homey.geolocation.getLatitude();
            const lon = this.homey.geolocation.getLongitude();
            const alerts = await this.#fetchAlerts();
            const now = new Date();

            const relevantAlerts = alerts.filter(alert => {
                const startAt = new Date(alert.start_at);
                const stopAt = new Date(alert.stop_at);

                if (now < startAt || now > stopAt) {
                    return false;
                }

                const polygon = this.#parsePolygon(alert.area);

                return polygon.length >= 3 && this.#isPointInPolygon(lat, lon, polygon);
            });

            this.#activeAlerts = relevantAlerts;

            for (const alert of relevantAlerts) {
                if (!this.#knownAlertIds.has(alert.id)) {
                    this.#knownAlertIds.add(alert.id);
                    await this.#fireTrigger(alert);
                }
            }

            const relevantIds = new Set(relevantAlerts.map(alert => alert.id));

            for (const id of this.#knownAlertIds) {
                if (!relevantIds.has(id)) {
                    this.#knownAlertIds.delete(id);
                }
            }

            this.settings.set(SETTINGS_KEY, [...this.#knownAlertIds]);
        } catch (err) {
            this.log('Failed to poll the NL Alert API:', err);
        }
    }

    async #fetchAlerts(): Promise<NlAlert[]> {
        const response = await fetch(API_URL);

        if (!response.ok) {
            throw new Error(`NL Alert API responded with status ${response.status}.`);
        }

        const data = await response.json() as NlAlertApiResponse;

        return data.data;
    }

    /**
     * Parses the area string (space-separated "lat,lon" pairs) into a polygon.
     */
    #parsePolygon(area: string): [number, number][] {
        return area.trim().split(' ').flatMap(pair => {
            const parts = pair.split(',').map(Number);

            if (parts.length !== 2 || parts.some(isNaN)) {
                return [];
            }

            return [[parts[0], parts[1]] as [number, number]];
        });
    }

    /**
     * Checks whether a given point (lat, lon) is inside the polygon using the ray casting algorithm.
     */
    #isPointInPolygon(lat: number, lon: number, polygon: [number, number][]): boolean {
        let inside = false;

        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const [latI, lonI] = polygon[i];
            const [latJ, lonJ] = polygon[j];

            if ((lonI > lon) !== (lonJ > lon) && lat < (latJ - latI) * (lon - lonI) / (lonJ - lonI) + latI) {
                inside = !inside;
            }
        }

        return inside;
    }

    async #fireTrigger(alert: NlAlert): Promise<void> {
        this.log(`Firing trigger for NL Alert: ${alert.id}`);

        await this.registry.fireTrigger(Triggers.AlertReceived, {}, {
            alert_id: alert.id,
            alert_message: alert.message,
            alert_start_at: alert.start_at,
            alert_stop_at: alert.stop_at
        });
    }
}

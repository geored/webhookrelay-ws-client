var WebSocket = require('universal-websocket-client');

import { Logger, transports, createLogger } from 'winston';
// import * as winston from "winston";
import { SubscriptionMessage } from './Messages/WebhookRelayEvent';

export default class WebhookRelayClient {
    private _socket?: WebSocket;
    private _logger: Logger;

    private _key: string = '';
    private _secret: string = '';
    private _buckets: string[] = [];

    private _handler!: (data: string) => void;

    private _connecting: boolean = false;
    private _manualDisconnect: boolean = false;
    private _connected: boolean = false;
    private _reconnectInterval: number = 1000 * 3;
    private _missingPingThreshold: number = 90000; // 90 seconds (pings should be every 1 minute)
    private _countdownTimeout: NodeJS.Timeout;

    /** @private */
    constructor(private readonly key: string, secret: string, buckets: string[], handler: (data: string) => void) {
        this._key = key;
        this._secret = secret;
        this._buckets = buckets;
        this._handler = handler;

        this._logger = createLogger({
            transports: [
                new transports.Console(),
            ]
        });
    }

    async connect() {
        return new Promise<void>((resolve, reject) => {
            if (this._connected) {
                resolve();
                return;
            }
            this._connecting = true;
            this._socket = new WebSocket('wss://my.webhookrelay.com/v1/socket');

            this._socket.onopen = (event: Event) => {
                this._connected = true;
                this._connecting = false;
                this._sendMessage({ action: 'auth', key: this._key, secret: this._secret });
                resolve();
            }

            this._socket.onmessage = (event: MessageEvent) => {
                this._receiveMessage(event.data)
            }

            this._socket.onerror = (event: Event) => {
                this._logger.error(`websocket error: ${event}`)

            }

            this._socket.onclose = (event: CloseEvent) => {
                this._socket = undefined;
                this._connected = false;
                this._connecting = false;
                if (this._manualDisconnect) {
                    // nothing to do, manual disconnect                    
                    this._logger.info('manual disconnect')
                    return
                }
                this._logger.info('connection closed, reconnecting..')              
                setTimeout(async () => {
                    this._reconnect()
                }, this._reconnectInterval)
            }
        });
    }

    /**
     * Begins connection timeout timer. Used
     * to identify dead connections when we are missing
     * pings from the server
     */
    protected beginCountdown() {
        clearTimeout(this._countdownTimeout)
        this._countdownTimeout = setTimeout(async () => {
            this._logger.warn('pings are missing, reconnecting...')
            this._connected = false;
            if (this._socket) {
                this._socket.close();
            }
        }, this._missingPingThreshold)
    }

    /**
     * Disconnects client
     */
    disconnect() {
        // don't wait for pings anymore
        clearTimeout(this._countdownTimeout)
        this._disconnect()
    }

    /**
	 * Checks whether the client is currently connecting to the server.
	 */
    protected get isConnecting() {
        return this._connecting;
    }

	/**
	 * Checks whether the client is currently connected to the server.
	 */
    protected get isConnected() {
        return this._connected;
    }

    private _disconnect() {
        this._connected = false;
        if (this._socket) {
            this._manualDisconnect = true;
            this._socket.close();
        }
    }

    private async _reconnect() {
        this._connected = false;
        if (this._socket) {
            this._socket.close();
        }
        await this.connect();
    }

    private _sendMessage(obj: any) {
        if (this._socket && this._connected) {
            const dataStr = JSON.stringify(obj);
            try {
                this._socket.send(dataStr);
            } catch (e) {
                this._logger.error('error while sending message: ', e)
            }
        } else {
            this._logger.warn('attempted to send a message on a closed websocket')
        }
    }

    private _receiveMessage(dataStr: string) {
        let msg = SubscriptionMessage.fromJSON(JSON.parse(dataStr))
        if (msg.getType() === 'status' && msg.getStatus() === 'authenticated') {
            this._sendMessage({ action: 'subscribe', buckets: this._buckets })
            return
        }

        this.beginCountdown();

        switch (msg.getType()) {
            case 'status':
                if (msg.getStatus() === 'authenticated') {
                    this._sendMessage({ action: 'subscribe', buckets: this._buckets })
                }
                if (msg.getStatus() === 'subscribed') {
                    this._logger.info('subscribed to webhook stream successfully')
                }
                if (msg.getStatus() === 'ping') {
                    this._sendMessage({ action: 'pong' })
                    return
                }

                if (msg.getStatus() === 'unauthorized') {
                    this._logger.error(`authorization failed, key ${this._key}`)
                }

                this._handler(dataStr)
                return
            case 'webhook':
                // raw payload
                this._handler(dataStr)
                return
            default:
                this._logger.warn(`unknown message type: ${msg.getType()}`)
                this._handler(dataStr)
                break;
        }
    }
}
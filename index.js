const { NanoresourcePromise: Nanoresource } = require('nanoresource-promise/emitter');
const Hypercore = require('hypercore');
const DHT = require('@hyperswarm/dht');
const Hyperswarm = require('hyperswarm');
const codecs = require('codecs');
const pump = require('pump');

const STREAM_PEER = Symbol('networker-stream-peer');

class CorestoreNetworker extends Nanoresource {
  constructor(corestore, opts = {}) {
    super();
    this.corestore = corestore;
    this.opts = opts;
    if (this.opts.bootstrap) {
      if (typeof this.opts.bootstrap === 'string') this.opts.bootstrap = [this.opts.bootstrap];
    }

    this.keyPair = opts.keyPair || DHT.keyPair();
    this._replicationOpts = {
      encrypt: true,
      live: true,
      keyPair: this.keyPair,
      onauthenticate: opts.onauthenticate,
    };

    this.streams = new Set();
    this.peers = new Set();

    this._joined = new Set();
    this._flushed = new Set();
    this._configurations = new Map();

    // this._extensions = new Set();

    this._streamsProcessing = 0;
    this._streamsProcessed = 0;

    // Passed in, or set in listen
    this.swarm = opts.swarm || null;

    this.setMaxListeners(0);
  }

  _replicate(protocolStream) {
    // The initiator parameter here is ignored, since we're passing in a stream.
    this.corestore.replicate(false, {
      ...this._replicationOpts,
      stream: protocolStream,
    });
  }

  async _flush(keyString, keyBuf, client) {
    if (client) await this.swarm.flush(); // Waits for the swarm to connect to pending peers.

    if (!this._joined.has(keyString)) {
      return;
    }
    const processingAfterFlush = this._streamsProcessing;
    if (this._streamsProcessed >= processingAfterFlush) {
      this._flushed.add(keyString);
      this.emit('flushed', keyBuf);
    } else {
      // Wait until the stream processing has caught up.
      const processedListener = () => {
        if (!this._joined.has(keyString)) {
          this.removeListener('stream-processed', processedListener);
          return;
        }
        if (this._streamsProcessed >= processingAfterFlush) {
          this._flushed.add(keyString);
          this.emit('flushed', keyBuf);
          this.removeListener('stream-processed', processedListener);
        }
      };
      this.on('stream-processed', processedListener);
    }
  }

  async _join(discoveryKey, opts = {}) {
    const keyString = toString(discoveryKey);
    const keyBuf = discoveryKey instanceof Buffer ? discoveryKey : Buffer.from(discoveryKey, 'hex');
    this._joined.add(keyString);
    this.emit('joined', keyBuf);
    let discovery = this.swarm.status(keyBuf);
    if (discovery)
      await discovery.refresh({
        server: opts.server,
        client: opts.client,
      });
    else
      discovery = this.swarm.join(keyBuf, {
        server: opts.server,
        client: opts.client,
      });
    if (opts.server) await discovery.flushed(); // Waits for the topic to be fully announced on the DHT

    const flushedProm = this._flush(keyString, keyBuf, opts.client);
    if (opts.flush !== false) await flushedProm;
    else flushedProm.catch(() => {});
  }

  _leave(discoveryKey) {
    const keyString = toString(discoveryKey);
    const keyBuf = discoveryKey instanceof Buffer ? discoveryKey : Buffer.from(discoveryKey, 'hex');
    this._joined.delete(keyString);
    return this.swarm.leave(keyBuf);
  }

  // _registerAllExtensions(peer) {
  //   for (const ext of this._extensions) {
  //     ext._registerExtension(peer);
  //   }
  // }

  // _unregisterAllExtensions(peer) {
  //   for (const ext of this._extensions) {
  //     ext._unregisterExtension(peer);
  //   }
  // }

  _addStream(stream) {
    this._replicate(stream);
    this.streams.add(stream);

    const peer = intoPeer(stream);
    this.peers.add(peer);
    stream[STREAM_PEER] = peer;

    // this._registerAllExtensions(peer);

    this.emit('peer-add', peer);
    this.emit('handshake', stream);
  }

  _removeStream(stream) {
    this.streams.delete(stream);
    if (stream[STREAM_PEER]) {
      const peer = stream[STREAM_PEER];
      // this._unregisterAllExtensions(peer);
      this.peers.delete(peer);
      this.emit('peer-remove', peer);
    }
  }

  _open() {
    const self = this;
    if (this.swarm) return;
    this.swarm = new Hyperswarm(this.opts);

    this.swarm.on('error', (err) => this.emit('error', err));
    this.swarm.on('connection', (socket, info) => {
      const isInitiator = !!info.client;
      if (socket.remoteAddress === '::ffff:127.0.0.1' || socket.remoteAddress === '127.0.0.1')
        return null;

      var finishedHandshake = false;
      var processed = false;

      const protocolStream = Hypercore.createProtocolStream(isInitiator, {
        ...this._replicationOpts,
      });
      protocolStream.on('handshake', () => {
        finishedHandshake = true;
        self._addStream(protocolStream);
        if (!processed) {
          processed = true;
          this._streamsProcessed++;
          this.emit('stream-processed');
        }
      });
      protocolStream.on('close', () => {
        this.emit('stream-closed', protocolStream, info, finishedHandshake);
        if (!processed) {
          processed = true;
          this._streamsProcessed++;
          this.emit('stream-processed');
        }
      });

      pump(socket, protocolStream, socket, (err) => {
        if (err) this.emit('replication-error', err);
        this._removeStream(protocolStream);
      });

      this.emit('stream-opened', protocolStream, info);
      this._streamsProcessing++;
    });
  }

  async _close() {
    if (!this.swarm) return null;

    // for (const ext of this._extensions) {
    //   ext.destroy();
    // }
    // this._extensions.clear();

    for (const stream of this.streams) {
      stream.destroy();
    }
    return await this.swarm.destroy();
  }

  listen() {
    return this.open();
  }

  status(discoveryKey) {
    if (Buffer.isBuffer(discoveryKey)) discoveryKey = discoveryKey.toString('hex');
    return this._configurations.get(discoveryKey);
  }

  allStatuses() {
    return [...this._configurations].map(([k, v]) => {
      return {
        discoveryKey: Buffer.from(k, 'hex'),
        ...v,
      };
    });
  }

  configure(discoveryKey, opts = {}) {
    const prom = this._configure(discoveryKey, opts);
    prom.catch(noop);
    return prom;
  }

  async _configure(discoveryKey, opts) {
    if (!this.swarm) this.open();
    if (this.swarm && this.swarm.destroyed) return;

    const config = {
      server: opts.server !== false,
      client: opts.client !== false,
    };
    opts = { ...opts, ...config };

    const keyString = toString(discoveryKey);
    const prev = this._configurations.get(keyString);
    const joining = config.server || config.client;

    if (joining) this._configurations.set(keyString, opts);
    else this._configurations.delete(keyString);

    if (joining) {
      if (
        opts.rejoin === false &&
        prev &&
        prev.client === config.client &&
        prev.server === config.server
      )
        return;
      return this._join(discoveryKey, opts);
    } else {
      return this._leave(discoveryKey);
    }
  }

  joined(discoveryKey) {
    if (typeof discoveryKey !== 'string') discoveryKey = discoveryKey.toString('hex');
    return this._joined.has(discoveryKey);
  }

  flushed(discoveryKey) {
    if (typeof discoveryKey !== 'string') discoveryKey = discoveryKey.toString('hex');
    return this._flushed.has(discoveryKey);
  }

  // registerExtension(name, handlers) {
  //   if (name && typeof name === 'object') return this.registerExtension(null, name);
  //   const ext = new SwarmExtension(this, name || handlers.name, handlers);
  //   this._extensions.add(ext);
  //   for (const peer of this.peers) {
  //     ext._registerExtension(peer);
  //   }
  //   return ext;
  // }
}

module.exports = CorestoreNetworker;

// class SwarmExtension {
//   constructor(networker, name, opts) {
//     if (typeof opts === 'function') opts = opts(this);
//     this.networker = networker;
//     this.name = name;
//     this.encoding = codecs((opts && opts.encoding) || 'binary');
//     this._peerExtensions = new Map();

//     this.onmessage = opts.onmessage;
//     this.onerror = opts.onerror;
//   }

//   _registerExtension(peer) {
//     // peer.stream.extensions.exclusive = false;
//     const peerExt = peer.stream.registerExtension(this.name, {
//       encoding: this.encoding,
//       onmessage: this.onmessage && ((message) => this.onmessage(message, peer)),
//       onerror: this.onerror && ((err) => this.onerror(err)),
//     });
//     this._peerExtensions.set(peer, peerExt);
//   }

//   _unregisterExtension(peer) {
//     if (!this._peerExtensions.has(peer)) return;
//     const peerExt = this._peerExtensions.get(peer);
//     peerExt.destroy();
//     this._peerExtensions.delete(peer);
//   }

//   broadcast(message) {
//     for (const peerExt of this._peerExtensions.values()) {
//       peerExt.send(message);
//     }
//   }

//   send(message, peer) {
//     const peerExt = this._peerExtensions.get(peer);
//     if (!peer) throw new Error('Peer must be specified.');
//     if (!peerExt)
//       throw new Error('Extension not registered for peer ' + peer.remotePublicKey.toString('hex'));
//     peerExt.send(message);
//   }

//   destroy() {
//     for (const peerExt of this._peerExtensions.values()) {
//       peerExt.destroy();
//     }
//     this._peerExtensions.clear();
//     this.onmessage = null;
//     this.onerror = null;
//   }
// }

function intoPeer(stream) {
  return {
    remotePublicKey: stream.remotePublicKey,
    remoteAddress: stream.remoteAddress,
    type: stream.remoteType,
    stream,
  };
}

function toString(dk) {
  return typeof dk === 'string' ? dk : dk.toString('hex');
}

function noop() {}

'use strict'

import {
  action,
  computed,
  configure,
  keys,
  observable,
  reaction,
  values,
  toJS,
  runInAction
} from 'mobx'

import ChannelStore from './ChannelStore'

import Logger from '../utils/logger'

import NetworkWorker from '../workers/network.worker.js'

configure({ enforceActions: 'observed' })

const logger = new Logger()

const peerUpdateInterval = 1000 // ms

export default class NetworkStore {
  worker = null

  constructor (rootStore) {
    this.sessionStore = rootStore.sessionStore
    this.settingsStore = rootStore.settingsStore

    this.joinChannel = this.joinChannel.bind(this)

    // this.channelPeerInterval = setInterval(() => {
    //   this.channelsAsArray.forEach(c => c.updatePeers())
    // }, peerUpdateInterval)

    this.worker = new NetworkWorker()
    this.worker.onmessage = this._onWorkerMessage.bind(this)
    this.worker.onerror = this._onWorkerError.bind(this)

    this.worker.postMessage('') // Init the worker

    // Stop if user logs out, start if not already online or not starting
    reaction(
      () => this.sessionStore.username,
      username => {
        if (!username) this.stop()
        else if (!(this.isOnline || this.starting)) this.start()
      }
    )
  }

  // Public instance variables

  networkName = 'Orbit DEV Network'

  @observable
  starting = false

  @observable
  stopping = false

  @observable
  isOnline = false

  @observable
  channels = {}

  @observable
  swarmPeers = []

  @observable
  defaultChannels = ['orbitdb']

  // Public instance getters

  @computed
  get hasUnreadMessages () {
    return this.channelsAsArray.some(c => c.hasUnreadMessages)
  }

  @computed
  get channelNames () {
    return keys(this.channels)
  }

  @computed
  get channelsAsArray () {
    return values(this.channels)
  }

  // Private instance actions

  @action.bound
  _onOrbitConnected () {
    this.isOnline = true
    this.starting = false

    // Join all channnels that are saved in localstorage for current user
    this.settingsStore.networkSettings.channels.forEach(this.joinChannel)

    // Join channels that should be joined by default
    if (this.settingsStore.networkSettings.channels.length === 0) {
      this.defaultChannels.forEach(this.joinChannel)
    }
  }

  @action.bound
  _onOrbitDisconnected () {
    this.isOnline = false
    this.stopping = false
  }

  @action.bound
  _onJoinedChannel (channelName) {
    if (typeof channelName !== 'string') return
    if (this.channelNames.includes(channelName)) {
      return this.channels[channelName]
    }

    // const orbitChannel = this.orbit.channels[channelName]
    this.channels[channelName] = new ChannelStore({
      network: this,
      channelName
    })

    // Save the channel to localstorage
    // so user will connect to it automatically next time
    const networkSettings = this.settingsStore.networkSettings
    networkSettings.channels = [
      ...networkSettings.channels.filter(c => c !== channelName),
      channelName
    ]

    return this.channels[channelName]
  }

  @action.bound
  _onLeftChannel (channelName) {
    if (typeof channelName !== 'string') return
    if (!this.channelNames.includes(channelName)) return

    this._removeChannel(channelName)

    // Remove the channel from localstorage
    const networkSettings = this.settingsStore.networkSettings
    networkSettings.channels = networkSettings.channels.filter(c => c !== channelName)
  }

  @action.bound
  _onSwarmPeerUpdate (peers) {
    this.swarmPeers = peers
  }

  @action.bound
  _removeChannel (channelName) {
    if (typeof channelName !== 'string') return
    delete this.channels[channelName]
  }

  @action.bound
  _resetSwarmPeers () {
    this.swarmPeers = []
  }

  // Private instance methods

  _onWorkerMessage ({ data }) {
    if (typeof data.action !== 'string') return
    if (typeof data.name !== 'string') return

    switch (data.action) {
      case 'orbit-event':
        switch (data.name) {
          case 'connected':
            this._onOrbitConnected()
            break
          case 'disconnected':
            this._onOrbitDisconnected()
            break
          case 'joined':
            this._onJoinedChannel(...data.args)
            break
          case 'left':
            this._onLeftChannel(...data.args)
            break
          case 'peers':
            this._onSwarmPeerUpdate(...data.args)
            break
          default:
            break
        }
        break
      case 'channel-event':
        const channel = this.channels[data.meta.channelName]

        switch (data.name) {
          case 'error':
            channel._onError(...data.args)
            break
          case 'load.progress':
            channel._onLoadProgress(data.meta.replicationStatus)
            break
          case 'replicate.progress':
            channel._onReplicateProgress(data.meta.replicationStatus)
            break
          case 'load.done':
            channel._onLoaded(data.meta.replicationStatus, data.meta.entries)
            break
          case 'replicate.done':
            channel._onReplicated(data.meta.replicationStatus, data.meta.entries)
            break
          case 'write':
            channel._onWrite(data.meta.replicationStatus, data.meta.entries)
            break
          default:
            break
        }
        break
      default:
        break
    }
  }

  _onWorkerError (error) {
    console.error(error.message)
  }

  // Public instance methods

  async joinChannel (channelName) {
    if (typeof channelName !== 'string') return
    if (!this.isOnline) throw new Error('Network is not online')
    if (!this.channelNames.includes(channelName)) {
      // await this.orbit.join(channelName)
      this.worker.postMessage({
        action: 'orbit:join-channel',
        options: { channelName }
      })
    }
    return this._onJoinedChannel(channelName)
  }

  async leaveChannel (channelName) {
    if (typeof channelName !== 'string') return
    if (!this.isOnline) throw new Error('Network is not online')
    if (this.channelNames.includes(channelName)) {
      this.worker.postMessage({
        action: 'orbit:leave-channel',
        options: { channelName }
      })
    }
    return this._onLeftChannel(channelName)
  }

  @action.bound
  async start () {
    if (this.isOnline) return

    runInAction(() => {
      this.starting = true
    })

    logger.info('Starting network')

    this.worker.postMessage({
      action: 'network:start',
      options: {
        ipfs: toJS(this.settingsStore.networkSettings.ipfs),
        orbit: toJS(this.settingsStore.networkSettings.orbit),
        username: this.sessionStore.username
      }
    })
  }

  @action.bound
  async stop () {
    if (!this.isOnline) return

    runInAction(() => {
      this.stopping = true
    })

    logger.info('Stopping network')

    clearInterval(this.channelPeerInterval)
    clearInterval(this.channelProcessInterval)

    this.worker.postMessage({
      action: 'network:stop'
    })

    this.channelNames.forEach(this._removeChannel)
    this._resetSwarmPeers()
  }
}

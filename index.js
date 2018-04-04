const Nimiq = require('../core/dist/node.js');
const argv = require('minimist')(process.argv.slice(2));
const config = require('./Config.js')(argv.config);

const PoolServer = require('./PoolServer.js');
const PoolService = require('./PoolService.js');
const PoolPayout = require('./PoolPayout.js');

(async () => {
    const START = Date.now();
    const TAG = 'Node';
    const $ = {};
    if (!config) {
        Nimiq.Log.w(TAG, 'Specify a valid config file with --config=FILE');
    }

    const isNano = config.type === 'nano';

    Nimiq.GenesisConfig.init(Nimiq.GenesisConfig.CONFIGS[config.network]);

    for(const seedPeer of config.seedPeers) {
        Nimiq.GenesisConfig.SEED_PEERS.push(Nimiq.WsPeerAddress.seed(seedPeer.host, seedPeer.port, seedPeer.publicKey));
    }

    const networkConfig = config.dumb
        ? new Nimiq.DumbNetworkConfig()
        : new Nimiq.WsNetworkConfig(config.host, config.port, config.tls.key, config.tls.cert);

    switch (config.type) {
        case 'full':
            $.consensus = await Nimiq.Consensus.full(networkConfig);
            break;
        case 'light':
            $.consensus = await Nimiq.Consensus.light(networkConfig);
            break;
        case 'nano':
            $.consensus = await Nimiq.Consensus.nano(networkConfig);
            break;
    }

    $.blockchain = $.consensus.blockchain;
    $.accounts = $.blockchain.accounts;
    $.mempool = $.consensus.mempool;
    $.network = $.consensus.network;

    console.log(`Peer address: ${networkConfig.peerAddress.toString()} - public key: ${networkConfig.keyPair.publicKey.toHex()}`);

    // TODO: Wallet key.
    $.walletStore = await new Nimiq.WalletStore();
    if (!config.wallet.seed) {
        // Load or create default wallet.
        $.wallet = await $.walletStore.getDefault();
    } else if (config.wallet.seed) {
        // Load wallet from seed.
        const mainWallet = await Nimiq.Wallet.loadPlain(config.wallet.seed);
        await $.walletStore.put(mainWallet);
        await $.walletStore.setDefault(mainWallet.address);
        $.wallet = mainWallet;
    }

    if (config.poolServer.enabled) {
        const poolServer = new PoolServer($.consensus, config.poolServer.name, Nimiq.Address.fromUserFriendlyAddress(config.poolServer.poolAddress),
            config.poolServer.port, config.poolServer.mySqlPsw, config.poolServer.mySqlHost, config.poolServer.sslKeyPath, config.poolServer.sslCertPath);
        process.on('SIGTERM', () => {
            poolServer.stop();
            process.exit(0);
        });
        process.on('SIGINT', () => {
            poolServer.stop();
            process.exit(0);
        });
    } else if (config.poolService.enabled) {
        const poolService = new PoolService($.consensus, Nimiq.Address.fromUserFriendlyAddress(config.poolService.poolAddress), config.poolService.mySqlPsw, config.poolService.mySqlHost);
        poolService.start();
    } else if (config.poolPayout.enabled) {
        const poolPayout = new PoolPayout($.consensus, $.wallet, config.poolPayout.mySqlPsw, config.poolPayout.mySqlHost);
        poolPayout.start();
    }

    const addresses = await $.walletStore.list();
    Nimiq.Log.i(TAG, `Managing wallets [${addresses.map(address => address.toUserFriendlyAddress())}]`);

    const account = !isNano ? await $.accounts.get($.wallet.address) : null;
    Nimiq.Log.i(TAG, `Wallet initialized for address ${$.wallet.address.toUserFriendlyAddress()}.`
        + (!isNano ? ` Balance: ${Nimiq.Policy.satoshisToCoins(account.balance)} NIM` : ''));

    Nimiq.Log.i(TAG, `Blockchain state: height=${$.blockchain.height}, headHash=${$.blockchain.headHash}`);

    $.blockchain.on('head-changed', (head) => {
        if ($.consensus.established || head.height % 100 === 0) {
            Nimiq.Log.i(TAG, `Now at block: ${head.height}`);
        }
    });

    $.network.on('peer-joined', (peer) => {
        Nimiq.Log.i(TAG, `Connected to ${peer.peerAddress.toString()}`);
    });

    $.consensus.on('established', () => {
        Nimiq.Log.i(TAG, `Blockchain ${config.type}-consensus established in ${(Date.now() - START) / 1000}s.`);
        Nimiq.Log.i(TAG, `Current state: height=${$.blockchain.height}, totalWork=${$.blockchain.totalWork}, headHash=${$.blockchain.headHash}`);
    });

    $.network.connect();
})().catch(e => {
    console.error(e);
    process.exit(1);
});

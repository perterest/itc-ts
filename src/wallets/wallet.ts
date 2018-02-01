import sqlstore from '../storage/sqlstore';
import * as composer from '../core/composer';
import {Signer} from '../core/signer';
import * as balances from '../core/balances';
import {Balances} from '../core/balances';
import Wallets from './Wallets';
import Account from '../common/Account';
import Signature from '../common/Signature';
import Units from '../models/Units';
import network from '../network/Network';

const TYPICAL_FEE = 1000;
const MAX_FEE = 20000;

export default class Wallet {
    signer: Signer;

    constructor(readonly wallet: Base64,
                readonly account: Account) {
        this.signer = new Signer(this.account.xPrivKey);
    }

    signWithLocalPrivateKey(wallet: Base64, account: number, isChange: boolean, addressIndex, buf: Buffer) {
        const path = `m/44/0/${account}/${isChange}/${addressIndex}`;
        const privateKey = this.account.xPrivKey.derive(path).privateKey;
        const privKeyBuf = privateKey.bn.toBuffer({size: 32});
        return Signature.sign(buf, privKeyBuf);
    }

    async address(): Promise<Address> {
        const addresses = await Wallets.readWalletAddresses(this.wallet);
        return addresses[0];
    }

    async readBalance(address?: Address): Promise<Balances> {
        if (!address) {
            address = await this.address();
        }
        return balances.readBalance(address);
    }

    async sendPayment(to: Address, amount: number) {
        const changeAddress = await this.address();
        return sendPayment(this.wallet, to, amount, changeAddress, this.signer);
    }
}

async function sendPayment(wallet: Base64,
                           to: Address,
                           amount: number,
                           changeAddress: Address,
                           signer: Signer) {

    const [fundedAddresses, signingAddresses] = await readFundedAndSigningAddresses(
        wallet, amount + TYPICAL_FEE, [], []);

    const outputs = [{
        address: to,
        amount: amount,
    }];

    const unit = await composer.composeUnit(
        null,
        signingAddresses,
        fundedAddresses,
        changeAddress,
        outputs,
        signer,
    );

    // save
    await Units.save(unit, 'good');

    // broadcast
    await network.broadcastUnit(unit);
}

async function readFundedAndSigningAddresses(walletId: Base64,
                                             estimatedAmount: number,
                                             signingAddresses: Address[],
                                             signingDeviceAddresses: Address[]): Promise<[Address[], Address[]]> {
    const fundedAddresses = await readFundedAddresses(walletId, estimatedAmount);
    const additionalAddresses = await readAdditionalSigningAddresses(fundedAddresses, signingAddresses, signingDeviceAddresses);
    return [fundedAddresses, signingAddresses.concat(additionalAddresses)];
}

async function readFundedAddresses(wallet: Base64, estimatedAmount: number): Promise<Address[]> {
    // find my paying utxo addresses
    // sort by |amount - estimatedAmount|
    const orderBy = `(SUM(amount) > ${estimatedAmount} DESC, ABS(SUM(amount)-${estimatedAmount} ASC`;
    const utxo = await sqlstore.all(`
            SELECT address, SUM(amount) AS total
            FROM outputs JOIN my_addresses USING(address)
            CROSS JOIN units USING(unit)
            WHERE wallet=? AND is_stable=1 AND sequence='good' AND is_spent=0 AND asset IS NULL
            AND NOT EXISTS (
                SELECT * FROM unit_authors JOIN units USING(unit)
                WHERE is_stable=0 AND unit_authors.address=outputs.address AND definition_chash IS NOT NULL
            )
            GROUP BY address ORDER BY ${orderBy}`,
        [wallet],
    );

    const fundedAddresses = [];
    let accumulatedAmount = 0;
    for (let i = 0; i < utxo.length; i++) {
        fundedAddresses.push(utxo[i].address);
        accumulatedAmount += utxo[i].total;
        if (accumulatedAmount > estimatedAmount + MAX_FEE) {
            break;
        }
    }
    return fundedAddresses;
}

async function readAdditionalSigningAddresses(payingAddresses: Address[],
                                              signingAddresses: Address[],
                                              signingDeviceAddresses: Address[]): Promise<Address[]> {
    const fromAddresses = payingAddresses.concat(signingAddresses);
    let sql = `
        SELECT DISTINCT address FROM shared_address_signing_paths
        WHERE shared_address IN(?)
        AND (
        EXISTS (SELECT 1 FROM my_addresses WHERE my_addresses.address=shared_address_signing_paths.address)
        OR
        EXISTS (SELECT 1 FROM shared_addresses WHERE shared_addresses.shared_address=shared_address_signing_paths.address)
        )
        AND (
            NOT EXISTS (SELECT 1 FROM addresses WHERE addresses.address=shared_address_signing_paths.address)
        OR (
            SELECT definition
        FROM address_definition_changes CROSS JOIN units USING(unit) LEFT JOIN definitions USING(definition_chash)
        WHERE address_definition_changes.address=shared_address_signing_paths.address AND is_stable=1 AND sequence='good'
        ORDER BY level DESC LIMIT 1
        ) IS NULL`;
    const params = [fromAddresses];
    if (signingAddresses.length > 0) {
        sql += ' AND address NOT IN(?)';
        params.push(signingAddresses);
    }
    if (signingDeviceAddresses && signingDeviceAddresses.length > 0) {
        sql += ' AND device_address IN(?)';
        params.push(signingDeviceAddresses);
    }
    const rows = await sqlstore.all(sql, params);
    const additionalAddresses = rows.map((row) => row.address);
    if (additionalAddresses.length === 0) {
        return [];
    } else {
        return readAdditionalSigningAddresses([], signingAddresses.concat(additionalAddresses), signingDeviceAddresses);
    }
}


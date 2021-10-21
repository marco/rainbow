import { EventEmitter } from 'events';
import path from 'path';
import { keyBy } from 'lodash';
import RNFS from 'react-native-fs';
import { rainbowFetch } from '../../rainbow-fetch';
import RAINBOW_TOKEN_LIST_DATA from './rainbow-token-list.json';
import { RainbowToken } from '@rainbow-me/entities';
import logger from 'logger';

// TODO: Make this a config value probably
const RAINBOW_TOKEN_LIST_URL =
  'https://metadata.p.rainbow.me/token-list/rainbow-token-list.json';

const RB_TOKEN_LIST_CACHE = 'rb-token-list.json';
const RB_TOKEN_LIST_ETAG = 'rb-token-list-etag.json';

const ethWithAddress: RainbowToken = {
  address: 'eth',
  decimals: 18,
  isRainbowCurated: true,
  isVerified: true,
  name: 'Ethereum',
  symbol: 'ETH',
  uniqueId: 'eth',
};

type TokenListData = typeof RAINBOW_TOKEN_LIST_DATA;
type ETagData = { etag: string | null };

/**
 * generateDerivedData generates derived data lists from RAINBOW_TOKEN_LIST_DATA.
 */
function generateDerivedData(tokenListData: TokenListData) {
  const tokenList: RainbowToken[] = tokenListData.tokens.map(token => {
    const { address: rawAddress, decimals, name, symbol, extensions } = token;
    const address = rawAddress.toLowerCase();
    return {
      address,
      decimals,
      name,
      symbol,
      uniqueId: address,
      ...extensions,
    };
  });

  const tokenListWithEth = [ethWithAddress, ...tokenList];
  const curatedRainbowTokenList = tokenListWithEth.filter(
    t => t.isRainbowCurated
  );

  const derivedData: {
    RAINBOW_TOKEN_LIST: Record<string, RainbowToken>;
    CURATED_TOKENS: Record<string, RainbowToken>;
    TOKEN_SAFE_LIST: Record<string, string>;
  } = {
    CURATED_TOKENS: keyBy(curatedRainbowTokenList, 'address'),
    RAINBOW_TOKEN_LIST: keyBy(tokenListWithEth, 'address'),
    TOKEN_SAFE_LIST: keyBy(
      curatedRainbowTokenList.flatMap(({ name, symbol }) => [name, symbol]),
      id => id.toLowerCase()
    ),
  };

  return derivedData;
}

async function readRNFSJsonData<T>(filename: string): Promise<T | null> {
  try {
    const data = await RNFS.readFile(
      path.join(RNFS.CachesDirectoryPath, filename),
      'utf8'
    );

    return JSON.parse(data);
  } catch (error) {
    // @ts-ignore: Skip missing file errors.
    if (error?.code !== 'ENOENT') {
      logger.sentry(error);
    }
    return null;
  }
}

async function writeRNFSJsonData<T>(filename: string, data: T) {
  try {
    await RNFS.writeFile(
      path.join(RNFS.CachesDirectoryPath, filename),
      JSON.stringify(data),
      'utf8'
    );
  } catch (error) {
    logger.sentry(`Token List: Error saving ${filename}`);
    logger.sentry(error);
  }
}

async function getTokenListUpdate(
  currentTokenListData: TokenListData
): Promise<{
  newTokenList?: TokenListData;
  status?: Response['status'];
}> {
  const etagData = await readRNFSJsonData<ETagData>(RB_TOKEN_LIST_ETAG);
  const etag = etagData?.etag;
  const commonHeaders = {
    Accept: 'application/json',
  };

  try {
    const { data, status, headers } = await rainbowFetch(
      RAINBOW_TOKEN_LIST_URL,
      {
        headers: etag
          ? { ...commonHeaders, 'If-None-Match': etag }
          : { ...commonHeaders },
        method: 'get',
      }
    );
    const currentDate = new Date(currentTokenListData?.timestamp);
    const freshDate = new Date((data as TokenListData)?.timestamp);
    if (freshDate > currentDate) {
      let work = [
        writeRNFSJsonData<TokenListData>(
          RB_TOKEN_LIST_CACHE,
          data as TokenListData
        ),
      ];

      if ((headers as Headers).get('etag')) {
        work.push(
          writeRNFSJsonData<ETagData>(RB_TOKEN_LIST_ETAG, {
            etag: (headers as Headers).get('etag'),
          })
        );
      }

      await Promise.all(work);
      return { newTokenList: data as TokenListData, status };
    } else {
      return { newTokenList: undefined, status };
    }

    // TODO: also set an update interval to skip on so we don't make tiny network requests every time the app opens?
  } catch (error) {
    if (error?.response?.status !== 304) {
      logger.sentry(error);
    }
    return {
      newTokenList: undefined,
      status: error?.response?.status,
    };
  }
}

class RainbowTokenList extends EventEmitter {
  #tokenListDataStorage = RAINBOW_TOKEN_LIST_DATA;
  #derivedData = generateDerivedData(RAINBOW_TOKEN_LIST_DATA);
  #updateJob: Promise<void> | null = null;

  constructor() {
    super();

    readRNFSJsonData<TokenListData>(RB_TOKEN_LIST_CACHE)
      .then(cachedData => {
        if (cachedData?.timestamp) {
          const bundledDate = new Date(this._tokenListData?.timestamp);
          const cachedDate = new Date(cachedData?.timestamp);

          if (cachedDate > bundledDate) this._tokenListData = cachedData;
        }
      })
      .catch(error => {
        logger.sentry(error);
      })
      .finally(() => {
        logger.debug('Token list initialized');
      });
  }

  // Wrapping #tokenListDataStorage so we can add events around updates.
  get _tokenListData() {
    return this.#tokenListDataStorage;
  }

  set _tokenListData(val) {
    this.#tokenListDataStorage = val;
    this.#derivedData = generateDerivedData(RAINBOW_TOKEN_LIST_DATA);
    this.emit('update');
    logger.debug('Token list updated');
  }

  update() {
    // deduplicate calls to update.
    if (!this.#updateJob) {
      this.#updateJob = this._updateJob();
    }

    return this.#updateJob;
  }

  async _updateJob(): Promise<void> {
    try {
      logger.debug('Token list checking for update');
      const { newTokenList, status } = await getTokenListUpdate(
        this._tokenListData
      );

      newTokenList
        ? logger.debug(
            `Token list update: new update loaded, generated on ${newTokenList?.timestamp}`
          )
        : status === 304
        ? logger.debug(
            `Token list update: no change since last update, skipping update.`
          )
        : logger.debug(
            `Token list update: Token list did not update. (Status: ${status}, CurrentListDate: ${this._tokenListData?.timestamp})`
          );

      if (newTokenList) {
        this._tokenListData = newTokenList;
      }
    } catch (error) {
      console.error(error);
      console.error(error.responseBody);
      console.error(error.response.status);
      logger.sentry(`Token list update error: ${(error as Error).message}`);
    } finally {
      this.#updateJob = null;
      logger.debug('Token list completed update check');
    }
  }

  get CURATED_TOKENS() {
    return this.#derivedData.CURATED_TOKENS;
  }

  get RAINBOW_TOKEN_LIST() {
    return this.#derivedData.RAINBOW_TOKEN_LIST;
  }

  get TOKEN_SAFE_LIST() {
    return this.#derivedData.TOKEN_SAFE_LIST;
  }
}

export const rainbowTokenList = new RainbowTokenList();

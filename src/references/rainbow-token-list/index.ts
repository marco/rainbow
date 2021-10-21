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
  'http://metadata.p.rainbow.me/token-list/rainbow-token-list.json';

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
    // TODO: handle missing file case before logging to sentry.
    logger.error(error);
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

  const { data, status, headers } = await rainbowFetch(RAINBOW_TOKEN_LIST_URL, {
    headers: etag
      ? { ...commonHeaders, 'If-None-Match': etag }
      : { ...commonHeaders },
    method: 'get',
  });

  if (status === 200) {
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
    }
  }
  // TODO: also set an update interval to skip on so we don't make tiny network requests every time the app opens?
  return { newTokenList: undefined, status };
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
          const bundledDate = new Date(this.#tokenListData?.timestamp);
          const cachedDate = new Date(cachedData?.timestamp);

          if (cachedDate > bundledDate) this.#tokenListData = cachedData;
        }
      })
      .catch((/* err */) => {
        // Log it somehow? Handle missing cache case?
      });
  }

  // Wrapping #tokenListDataStorage so we can add events around updates.
  get #tokenListData() {
    return this.#tokenListDataStorage;
  }

  set #tokenListData(val) {
    this.#tokenListDataStorage = val;
    this.#derivedData = generateDerivedData(RAINBOW_TOKEN_LIST_DATA);
    this.emit('update');
  }

  update() {
    // deduplicate calls to update.
    if (!this.#updateJob) {
      this.#updateJob = this.#update();
    }

    return this.#updateJob;
  }

  async #update(): Promise<void> {
    try {
      const { newTokenList, status } = await getTokenListUpdate(
        this.#tokenListData
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
            `Token list update: Token list did not update. (Status: ${status}, CurrentListDate: ${
              this.#tokenListData?.timestamp
            })`
          );

      if (newTokenList) this.#tokenListData = newTokenList;
    } catch (error) {
      logger.sentry(`Token list update error: ${(error as Error).message}`);
    } finally {
      this.#updateJob = null;
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

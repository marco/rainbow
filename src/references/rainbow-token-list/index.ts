import { EventEmitter } from 'events';
import path from 'path';
import { keyBy } from 'lodash';
import RNFS from 'react-native-fs';
import { rainbowFetch } from '../../rainbow-fetch';
import RAINBOW_TOKEN_LIST_DATA from './rainbow-token-list.json';
import { RainbowToken } from '@rainbow-me/entities';

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
type ETagData = { etag: string };

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
    // todo: handle error better
    return null;
  }
}

function writeRNFSJsonData<T>(filename: string, data: T) {
  return RNFS.writeFile(
    path.join(RNFS.CachesDirectoryPath, filename),
    JSON.stringify(data),
    'utf8'
  );
}

class RainbowTokenList extends EventEmitter {
  #tokenListData = RAINBOW_TOKEN_LIST_DATA;
  #derivedData = generateDerivedData(RAINBOW_TOKEN_LIST_DATA);
  #updateJob: Promise<{ newData: Boolean; error?: Error }> | null = null;

  constructor() {
    super();

    readRNFSJsonData<TokenListData>(RB_TOKEN_LIST_CACHE)
      .then(cachedData => {
        if (cachedData?.timestamp) {
          const bundledDate = new Date(this.tokenListData?.timestamp);
          const cachedDate = new Date(cachedData?.timestamp);

          if (cachedDate > bundledDate) this.tokenListData = cachedData;
        }
      })
      .catch((/* err */) => {
        // Log it somehow? Handle missing cache case?
      });
  }

  get tokenListData() {
    return this.#tokenListData;
  }

  set tokenListData(val) {
    this.#tokenListData = val;
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

  async #update(): Promise<{ newData: Boolean; error?: Error }> {
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

      if (status === 200) {
        const currentDate = new Date(this.tokenListData?.timestamp);
        const freshDate = new Date(data?.timestamp);
        if (freshDate > currentDate) {
          let work = [
            writeRNFSJsonData<TokenListData>(
              RB_TOKEN_LIST_CACHE,
              data as TokenListData
            ),
          ];

          if (headers.get('etag')) {
            work.push(
              writeRNFSJsonData<ETagData>(RB_TOKEN_LIST_ETAG, {
                etag: headers.get('etag'),
              })
            );
          }

          await Promise.all(work);
          this.tokenListData = data as TokenListData;
          return { newData: true };
        }
      }
      // handle 304 or other status codes?
      return { newData: false };
    } catch (error) {
      // TODO: more here? log?
      return {
        error:
          error instanceof Error ? error : new Error(`Error updating data`),
        newData: false,
      };
    } finally {
      this.#updateJob = null; // clear update singleton
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

import { EventEmitter } from 'events';
import path from 'path';
import { keyBy, memoize } from 'lodash';
import RNFS from 'react-native-fs';
import RAINBOW_TOKEN_LIST_DATA from './rainbow-token-list.json';
import { RainbowToken } from '@rainbow-me/entities';

memoize.Cache = WeakMap;

const RB_TOKEN_LIST_CACHE = 'rb-token-list.json';

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

async function readCachedData(): Promise<TokenListData> {
  const data = await RNFS.readFile(
    path.join(RNFS.CachesDirectoryPath, RB_TOKEN_LIST_CACHE),
    'utf8'
  );

  return JSON.parse(data);
}

class RainbowTokenList extends EventEmitter {
  #tokenListData = RAINBOW_TOKEN_LIST_DATA;
  #derivedData = generateDerivedData(RAINBOW_TOKEN_LIST_DATA);

  constructor() {
    super();

    readCachedData()
      .then(data => {
        const bundledDate = new Date(this.tokenListData?.timestamp);
        const cachedDate = new Date(this.tokenListData?.timestamp);

        if (cachedDate > bundledDate) this.tokenListData = data;
        this.emit('ready');
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
    this.emit('update', this.#derivedData);
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

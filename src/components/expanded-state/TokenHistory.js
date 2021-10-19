import React, { Fragment, useContext, useEffect, useMemo, useRef } from 'react';
import { Column, Row } from '../layout';
import { Text } from '../text';
import { apiGetTokenHistory } from '@rainbow-me/handlers/opensea-api';

/**
 * Requirements: 
 * A Collapsible "History" Tab under expanded NFT States
 * Use Opensea API to display:
 * Minting - Sales - Transfers - Listings 
 * Scrollable horizonatally?
 * Need contract address, token ID to query Opensea with
 * How many events to query?
 */

const TokenHistory = ({ 
    contractAndToken,
    network
  }) => {

  const [tokenHistory, setTokenHistory] = useState("yo");
  const [contractAddress, setContractAddress] = useState("");
  const [tokenID, setTokenID] = useState("");

  useEffect(() => {
    const tokenInfoArray = contractAndToken.split("/");
    setContractAddress(tokenInfoArray[0]);
    setTokenID(tokenInfoArray[1]);
  });


  //Query opensea using the contract address + tokenID
  useEffect(() => {
    apiGetTokenHistory(network, contractAddress, tokenID).then(result => {
      setTokenHistory(result);
    });
  }, [contractAddress, tokenID]);

  return (
    <Column>
      <Row>
        <Text>{contractAddress}</Text>  
      </Row>
      <Row>
        <Text>{tokenID}</Text>  
      </Row>
      <Row>
        <Text>{tokenHistory}</Text>  
      </Row>
    </Column>
  )
}

export default TokenHistory;


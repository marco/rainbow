import { useRoute } from '@react-navigation/native';
import analytics from '@segment/analytics-react-native';
import { captureEvent, captureException } from '@sentry/react-native';
import { isEmpty, isString, toLower } from 'lodash';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { InteractionManager, Keyboard, StatusBar } from 'react-native';
import { getStatusBarHeight, isIphoneX } from 'react-native-iphone-x-helper';
import { KeyboardArea } from 'react-native-keyboard-area';
import { useDispatch } from 'react-redux';
import styled from 'styled-components';
import { dismissingScreenListener } from '../../shim';
import { Column } from '../components/layout';
import {
  SendAssetForm,
  SendAssetList,
  SendContactList,
  SendHeader,
  SendTransactionSpeed,
} from '../components/send';
import { SheetActionButton } from '../components/sheet';
import { AssetType, AssetTypes } from '@rainbow-me/entities';
import { isNativeAsset } from '@rainbow-me/handlers/assets';
import {
  createSignableTransaction,
  estimateGasLimit,
  getProviderForNetwork,
  resolveNameOrAddress,
  web3Provider,
} from '@rainbow-me/handlers/web3';
import isNativeStackAvailable from '@rainbow-me/helpers/isNativeStackAvailable';
import networkTypes from '@rainbow-me/helpers/networkTypes';
import {
  checkIsValidAddressOrDomain,
  isENSAddressFormat,
} from '@rainbow-me/helpers/validators';
import {
  useAccountAssets,
  useAccountSettings,
  useCoinListEditOptions,
  useContacts,
  useGas,
  useMagicAutofocus,
  useMaxInputBalance,
  usePrevious,
  useRefreshAccountData,
  useSendableUniqueTokens,
  useSendSavingsAccount,
  useTransactionConfirmation,
  useUpdateAssetOnchainBalance,
  useUserAccounts,
} from '@rainbow-me/hooks';
import { sendTransaction } from '@rainbow-me/model/wallet';
import { useNavigation } from '@rainbow-me/navigation/Navigation';
import { ETH_ADDRESS } from '@rainbow-me/references';
import Routes from '@rainbow-me/routes';
import { borders } from '@rainbow-me/styles';
import {
  convertAmountAndPriceToNativeDisplay,
  convertAmountFromNativeValue,
  formatInputDecimals,
} from '@rainbow-me/utilities';
import { deviceUtils, gasUtils } from '@rainbow-me/utils';
import logger from 'logger';

const sheetHeight = deviceUtils.dimensions.height - (android ? 30 : 10);
const statusBarHeight = getStatusBarHeight(true);

const Container = styled.View`
  background-color: ${({ theme: { colors } }) => colors.transparent};
  flex: 1;
  padding-top: ${isNativeStackAvailable ? 0 : statusBarHeight};
  width: 100%;
`;

const SheetContainer = styled(Column).attrs({
  align: 'center',
  flex: 1,
})`
  ${borders.buildRadius('top', isNativeStackAvailable ? 0 : 16)};
  background-color: ${({ theme: { colors } }) => colors.white};
  height: ${isNativeStackAvailable || android ? sheetHeight : '100%'};
  width: 100%;
`;

const KeyboardSizeView = styled(KeyboardArea)`
  width: 100%;
  background-color: ${({ showAssetForm, theme: { colors } }) =>
    showAssetForm ? colors.lighterGrey : colors.white};
`;

export default function SendSheet(props) {
  const dispatch = useDispatch();
  const { goBack, navigate, addListener } = useNavigation();
  const { dataAddNewTransaction } = useTransactionConfirmation();
  const updateAssetOnchainBalanceIfNeeded = useUpdateAssetOnchainBalance();
  const { allAssets } = useAccountAssets();
  const {
    gasLimit,
    gasPrices,
    isSufficientGas,
    prevSelectedGasPrice,
    selectedGasPrice,
    startPollingGasPrices,
    stopPollingGasPrices,
    txFees,
    updateDefaultGasLimit,
    updateGasPriceOption,
    updateTxFee,
  } = useGas();
  const isDismissing = useRef(false);

  const recipientFieldRef = useRef();

  useEffect(() => {
    if (ios) {
      return;
    }
    dismissingScreenListener.current = () => {
      Keyboard.dismiss();
      isDismissing.current = true;
    };
    const unsubscribe = addListener(
      'transitionEnd',
      ({ data: { closing } }) => {
        if (!closing && isDismissing.current) {
          isDismissing.current = false;
          recipientFieldRef?.current?.focus();
        }
      }
    );
    return () => {
      unsubscribe();
      dismissingScreenListener.current = undefined;
    };
  }, [addListener]);
  const { contacts, onRemoveContact, filteredContacts } = useContacts();
  const { userAccounts } = useUserAccounts();
  const { sendableUniqueTokens } = useSendableUniqueTokens();
  const {
    accountAddress,
    nativeCurrency,
    nativeCurrencySymbol,
    network,
  } = useAccountSettings();

  const savings = useSendSavingsAccount();
  const fetchData = useRefreshAccountData();
  const { hiddenCoins, pinnedCoins } = useCoinListEditOptions();

  const [amountDetails, setAmountDetails] = useState({
    assetAmount: '',
    isSufficientBalance: false,
    nativeAmount: '',
  });
  const [currentNetwork, setCurrentNetwork] = useState();
  const prevNetwork = usePrevious(currentNetwork);
  const [currentInput, setCurrentInput] = useState('');
  const [isValidAddress, setIsValidAddress] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [selected, setSelected] = useState({});
  const { maxInputBalance, updateMaxInputBalance } = useMaxInputBalance();
  const [currentProvider, setCurrentProvider] = useState();

  const showEmptyState = !isValidAddress;
  const showAssetList = isValidAddress && isEmpty(selected);
  const showAssetForm = isValidAddress && !isEmpty(selected);

  const { handleFocus, triggerFocus } = useMagicAutofocus(
    recipientFieldRef,
    useCallback(
      lastFocusedRef => (showAssetList ? null : lastFocusedRef.current),
      [showAssetList]
    )
  );

  useEffect(() => {
    // We can start fetching gas prices
    // after we know the network that the asset
    // belongs to
    if (prevNetwork !== currentNetwork) {
      InteractionManager.runAfterInteractions(() =>
        startPollingGasPrices(currentNetwork)
      );
    }
    return () => {
      InteractionManager.runAfterInteractions(() => stopPollingGasPrices());
    };
  }, [
    currentNetwork,
    prevNetwork,
    startPollingGasPrices,
    stopPollingGasPrices,
  ]);

  // Recalculate balance when gas price changes
  useEffect(() => {
    if (
      selected?.address === ETH_ADDRESS &&
      (prevSelectedGasPrice?.txFee?.value?.amount ?? 0) !==
        (selectedGasPrice?.txFee?.value?.amount ?? 0)
    ) {
      updateMaxInputBalance(selected);
    }
  }, [prevSelectedGasPrice, selected, selectedGasPrice, updateMaxInputBalance]);

  const sendUpdateAssetAmount = useCallback(
    newAssetAmount => {
      const _assetAmount = newAssetAmount.replace(/[^0-9.]/g, '');
      let _nativeAmount = '';
      if (_assetAmount.length) {
        const priceUnit = selected?.price?.value ?? 0;
        const {
          amount: convertedNativeAmount,
        } = convertAmountAndPriceToNativeDisplay(
          _assetAmount,
          priceUnit,
          nativeCurrency
        );
        _nativeAmount = formatInputDecimals(
          convertedNativeAmount,
          _assetAmount
        );
      }

      const _isSufficientBalance =
        Number(_assetAmount) <= Number(maxInputBalance);
      setAmountDetails({
        assetAmount: _assetAmount,
        isSufficientBalance: _isSufficientBalance,
        nativeAmount: _nativeAmount,
      });
    },
    [maxInputBalance, nativeCurrency, selected]
  );

  const sendUpdateSelected = useCallback(
    newSelected => {
      updateMaxInputBalance(newSelected);
      if (newSelected?.type === AssetTypes.nft) {
        setAmountDetails({
          assetAmount: '1',
          isSufficientBalance: true,
          nativeAmount: '0',
        });
        setSelected({
          ...newSelected,
          symbol: newSelected?.asset_contract?.name,
        });
      } else {
        setSelected(newSelected);
        sendUpdateAssetAmount('');
        // Since we don't trust the balance from zerion,
        // let's hit the blockchain and update it
        if (currentProvider) {
          updateAssetOnchainBalanceIfNeeded(
            newSelected,
            accountAddress,
            currentNetwork,
            currentProvider,
            updatedAsset => {
              // set selected asset with new balance
              setSelected(updatedAsset);
              // Update selected to recalculate the maxInputAmount
              sendUpdateSelected(updatedAsset);
            }
          );
        }
      }
    },
    [
      accountAddress,
      currentNetwork,
      currentProvider,
      sendUpdateAssetAmount,
      updateAssetOnchainBalanceIfNeeded,
      updateMaxInputBalance,
    ]
  );

  useEffect(() => {
    const updateNetworkAndProvider = async () => {
      if (
        selected?.type &&
        (!currentNetwork || prevNetwork !== currentNetwork)
      ) {
        let provider = web3Provider;
        switch (selected.type) {
          case AssetType.polygon:
            setCurrentNetwork(networkTypes.polygon);
            provider = await getProviderForNetwork(networkTypes.polygon);
            break;
          case AssetType.arbitrum:
            setCurrentNetwork(networkTypes.arbitrum);
            provider = await getProviderForNetwork(networkTypes.arbitrum);
            break;
          case AssetTypes.optimism:
            setCurrentNetwork(networkTypes.optimism);
            provider = await getProviderForNetwork(networkTypes.optimism);
            break;
          default:
            setCurrentNetwork(network);
        }
        setCurrentProvider(provider);
      }
    };
    updateNetworkAndProvider();
  }, [
    currentNetwork,
    network,
    prevNetwork,
    selected,
    selected.type,
    sendUpdateSelected,
  ]);

  useEffect(() => {
    if (currentProvider) {
      sendUpdateSelected(selected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProvider]);

  const onChangeNativeAmount = useCallback(
    newNativeAmount => {
      if (!isString(newNativeAmount)) return;
      const _nativeAmount = newNativeAmount.replace(/[^0-9.]/g, '');
      let _assetAmount = '';
      if (_nativeAmount.length) {
        const priceUnit = selected?.price?.value ?? 0;
        const convertedAssetAmount = convertAmountFromNativeValue(
          _nativeAmount,
          priceUnit,
          selected.decimals
        );
        _assetAmount = formatInputDecimals(convertedAssetAmount, _nativeAmount);
      }

      const _isSufficientBalance =
        Number(_assetAmount) <= Number(maxInputBalance);

      setAmountDetails({
        assetAmount: _assetAmount,
        isSufficientBalance: _isSufficientBalance,
        nativeAmount: _nativeAmount,
      });
      analytics.track('Changed native currency input in Send flow');
    },
    [maxInputBalance, selected]
  );

  const sendMaxBalance = useCallback(async () => {
    const newBalanceAmount = await updateMaxInputBalance(selected);
    sendUpdateAssetAmount(newBalanceAmount);
  }, [selected, sendUpdateAssetAmount, updateMaxInputBalance]);

  const onChangeAssetAmount = useCallback(
    newAssetAmount => {
      if (isString(newAssetAmount)) {
        sendUpdateAssetAmount(newAssetAmount);
        analytics.track('Changed token input in Send flow');
      }
    },
    [sendUpdateAssetAmount]
  );

  const onSubmit = useCallback(async () => {
    const validTransaction =
      isValidAddress && amountDetails.isSufficientBalance && isSufficientGas;
    if (!selectedGasPrice.txFee || !validTransaction) {
      logger.sentry('preventing tx submit for one of the following reasons:');
      logger.sentry('selectedGasPrice.txFee ? ', selectedGasPrice?.txFee);
      logger.sentry('validTransaction ? ', validTransaction);
      captureEvent('Preventing tx submit');
      return false;
    }

    let submitSuccess = false;
    let updatedGasLimit = null;

    // Attempt to update gas limit before sending ERC20 / ERC721
    if (!isNativeAsset(selected.address, currentNetwork)) {
      try {
        // Estimate the tx with gas limit padding before sending
        updatedGasLimit = await estimateGasLimit(
          {
            address: accountAddress,
            amount: amountDetails.assetAmount,
            asset: selected,
            recipient,
          },
          true,
          currentNetwork
        );
        logger.log('gasLimit updated before sending', {
          after: updatedGasLimit,
          before: gasLimit,
        });

        updateTxFee(updatedGasLimit, null, currentNetwork);
        // eslint-disable-next-line no-empty
      } catch (e) {}
    }

    let toAddress = recipient;
    if (isENSAddressFormat(recipient)) {
      toAddress = await resolveNameOrAddress(recipient);
    }

    const txDetails = {
      amount: amountDetails.assetAmount,
      asset: selected,
      from: accountAddress,
      gasLimit: updatedGasLimit || gasLimit,
      gasPrice: selectedGasPrice.value?.amount,
      nonce: null,
      to: toAddress,
    };
    try {
      const signableTransaction = await createSignableTransaction(txDetails);
      const txResult = await sendTransaction({
        provider: currentProvider,
        transaction: signableTransaction,
      });
      const { hash, nonce } = txResult;
      if (!isEmpty(hash)) {
        submitSuccess = true;
        txDetails.hash = hash;
        txDetails.nonce = nonce;
        txDetails.arbitrum = selected.type === AssetType.arbitrum;
        txDetails.optimism = selected.type === AssetType.optimism;
        txDetails.polygon = selected.type === AssetType.polygon;
        await dispatch(
          dataAddNewTransaction(txDetails, null, false, currentProvider)
        );
      }
    } catch (error) {
      logger.sentry('TX Details', txDetails);
      logger.sentry('SendSheet onSubmit error');
      logger.sentry(error);
      captureException(error);
      submitSuccess = false;
    }
    return submitSuccess;
  }, [
    accountAddress,
    amountDetails.assetAmount,
    amountDetails.isSufficientBalance,
    currentNetwork,
    currentProvider,
    dataAddNewTransaction,
    dispatch,
    gasLimit,
    isSufficientGas,
    isValidAddress,
    recipient,
    selected,
    selectedGasPrice.txFee,
    selectedGasPrice.value?.amount,
    updateTxFee,
  ]);

  const submitTransaction = useCallback(async () => {
    if (Number(amountDetails.assetAmount) <= 0) {
      logger.sentry('amountDetails.assetAmount ? ', amountDetails?.assetAmount);
      captureEvent('Preventing tx submit due to amount <= 0');
      return false;
    }

    const submitSuccessful = await onSubmit();
    analytics.track('Sent transaction', {
      assetName: selected?.name || '',
      assetType: selected?.type || '',
      isRecepientENS: toLower(recipient.slice(-4)) === '.eth',
    });
    if (submitSuccessful) {
      goBack();
      navigate(Routes.WALLET_SCREEN);
      InteractionManager.runAfterInteractions(() => {
        navigate(Routes.PROFILE_SCREEN);
      });
    }
  }, [
    amountDetails.assetAmount,
    goBack,
    navigate,
    onSubmit,
    recipient,
    selected?.name,
    selected?.type,
  ]);

  const onPressTransactionSpeed = useCallback(
    onSuccess => {
      const hideCustom = true;
      gasUtils.showTransactionSpeedOptions(
        gasPrices,
        txFees,
        gasPriceOption => updateGasPriceOption(gasPriceOption, currentNetwork),
        onSuccess,
        hideCustom
      );
    },
    [gasPrices, txFees, updateGasPriceOption, currentNetwork]
  );

  const showConfirmationSheet = useCallback(async () => {
    let toAddress = recipient;
    if (isENSAddressFormat(recipient)) {
      toAddress = await resolveNameOrAddress(recipient);
    }
    Keyboard.dismiss();
    navigate(Routes.SEND_CONFIRMATION_SHEET, {
      amountDetails: amountDetails,
      asset: selected,
      callback: submitTransaction,
      currentInput,
      from: accountAddress,
      gasLimit: gasLimit,
      gasPrice: selectedGasPrice.value?.amount,
      isSufficientGas,
      network: currentNetwork,
      to: recipient,
      toAddress,
    });
  }, [
    accountAddress,
    amountDetails,
    currentInput,
    currentNetwork,
    gasLimit,
    isSufficientGas,
    navigate,
    recipient,
    selected,
    selectedGasPrice.value?.amount,
    submitTransaction,
  ]);

  const onPressSend = useCallback(() => {
    if (isIphoneX()) {
      showConfirmationSheet();
    } else {
      onPressTransactionSpeed(showConfirmationSheet);
    }
  }, [onPressTransactionSpeed, showConfirmationSheet]);

  const onResetAssetSelection = useCallback(() => {
    analytics.track('Reset asset selection in Send flow');
    sendUpdateSelected({});
  }, [sendUpdateSelected]);

  const onChangeInput = useCallback(event => {
    setCurrentInput(event);
    setRecipient(event);
  }, []);

  useEffect(() => {
    updateDefaultGasLimit();
  }, [updateDefaultGasLimit]);

  useEffect(() => {
    if (
      (isValidAddress && showAssetList) ||
      (isValidAddress && showAssetForm && selected?.type === AssetTypes.nft)
    ) {
      Keyboard.dismiss();
    }
  }, [isValidAddress, selected, showAssetForm, showAssetList]);

  const { params } = useRoute();
  const assetOverride = params?.asset;
  const prevAssetOverride = usePrevious(assetOverride);

  useEffect(() => {
    if (assetOverride && assetOverride !== prevAssetOverride) {
      sendUpdateSelected(assetOverride);
    }
  }, [assetOverride, prevAssetOverride, sendUpdateSelected]);

  const recipientOverride = params?.address;

  useEffect(() => {
    if (recipientOverride && !recipient) {
      setRecipient(recipientOverride);
    }
  }, [recipient, recipientOverride]);

  const checkAddress = useCallback(async () => {
    const validAddress = await checkIsValidAddressOrDomain(recipient);
    setIsValidAddress(validAddress);
  }, [recipient]);

  useEffect(() => {
    checkAddress();
  }, [checkAddress]);

  useEffect(() => {
    if (isValidAddress) {
      estimateGasLimit(
        {
          address: accountAddress,
          amount: amountDetails.assetAmount,
          asset: selected,
          recipient,
        },
        false,
        currentProvider,
        currentNetwork
      )
        .then(gasLimit => updateTxFee(gasLimit, null, currentNetwork))
        .catch(() => updateTxFee(null, null, currentNetwork));
    }
  }, [
    accountAddress,
    amountDetails.assetAmount,
    currentNetwork,
    currentProvider,
    dispatch,
    isValidAddress,
    recipient,
    selected,
    updateTxFee,
  ]);

  const { colors, isDarkMode } = useTheme();

  const { buttonDisabled, buttonLabel } = useMemo(() => {
    const isZeroAssetAmount = Number(amountDetails.assetAmount) <= 0;

    let disabled = true;
    let label = 'Enter an Amount';

    let nativeToken = 'ETH';
    if (network === networkTypes.polygon) {
      nativeToken = 'MATIC';
    }

    if (!isZeroAssetAmount && !isSufficientGas) {
      disabled = true;
      label = `Insufficient ${nativeToken}`;
    } else if (!isZeroAssetAmount && !amountDetails.isSufficientBalance) {
      disabled = true;
      label = 'Insufficient Funds';
    } else if (!isZeroAssetAmount) {
      disabled = false;
      label = '􀕹 Review';
    }

    return { buttonDisabled: disabled, buttonLabel: label };
  }, [
    amountDetails.assetAmount,
    amountDetails.isSufficientBalance,
    isSufficientGas,
    network,
  ]);

  return (
    <Container>
      {ios && <StatusBar barStyle="light-content" />}
      <SheetContainer>
        <SendHeader
          contacts={contacts}
          isValidAddress={isValidAddress}
          onChangeAddressInput={onChangeInput}
          onFocus={handleFocus}
          onPressPaste={setRecipient}
          onRefocusInput={triggerFocus}
          recipient={recipient}
          recipientFieldRef={recipientFieldRef}
          removeContact={onRemoveContact}
          showAssetList={showAssetList}
          userAccounts={userAccounts}
        />
        {showEmptyState && (
          <SendContactList
            contacts={filteredContacts}
            currentInput={currentInput}
            onPressContact={setRecipient}
            removeContact={onRemoveContact}
            userAccounts={userAccounts}
          />
        )}
        {showAssetList && (
          <SendAssetList
            allAssets={allAssets}
            fetchData={fetchData}
            hiddenCoins={hiddenCoins}
            nativeCurrency={nativeCurrency}
            network={network}
            onSelectAsset={sendUpdateSelected}
            pinnedCoins={pinnedCoins}
            savings={savings}
            uniqueTokens={sendableUniqueTokens}
          />
        )}
        {showAssetForm && (
          <SendAssetForm
            {...props}
            allAssets={allAssets}
            assetAmount={amountDetails.assetAmount}
            buttonRenderer={
              <SheetActionButton
                color={
                  buttonDisabled
                    ? isDarkMode
                      ? colors.darkGrey
                      : colors.lightGrey
                    : colors.appleBlue
                }
                disabled={buttonDisabled}
                label={buttonLabel}
                onPress={onPressSend}
                size="big"
                testID="send-sheet-confirm"
                weight="bold"
              />
            }
            nativeAmount={amountDetails.nativeAmount}
            nativeCurrency={nativeCurrency}
            onChangeAssetAmount={onChangeAssetAmount}
            onChangeNativeAmount={onChangeNativeAmount}
            onFocus={handleFocus}
            onResetAssetSelection={onResetAssetSelection}
            selected={selected}
            sendMaxBalance={sendMaxBalance}
            txSpeedRenderer={
              isIphoneX() && (
                <SendTransactionSpeed
                  gasPrice={selectedGasPrice}
                  nativeCurrencySymbol={nativeCurrencySymbol}
                  onPressTransactionSpeed={onPressTransactionSpeed}
                />
              )
            }
          />
        )}
        {android && showAssetForm ? (
          <KeyboardSizeView showAssetForm={showAssetForm} />
        ) : null}
      </SheetContainer>
    </Container>
  );
}

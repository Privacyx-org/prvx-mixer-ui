import { useEffect, useState } from "react";
import { ethers } from "ethers";
import logo from "./assets/logo-PRVX.svg";
import logo3d from "./assets/logo-3d.png";

const PRVX_ADDRESS = "0x700509775B89e6695Da271c79c976d65846A0180";
const MIXER_ADDRESS = "0x841099f40f01F220A79a81f9a463922B875fB0Ce";

const prvxAbi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)"
];

const mixerAbi = [
  "event Deposited(address indexed sender, uint256 amount)",
  "event Withdrawn(address indexed receiver, uint256 amount, uint256 fee)",
  "function deposit(uint256 amount) external",
  "function withdraw(address recipient, uint256 amount) external",
  "function getDeposit(address user) view returns (uint256 amount, uint256 timestamp)"
];

function App() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [address, setAddress] = useState(null);
  const [status, setStatus] = useState("Connect your wallet");
  const [amount, setAmount] = useState("100");
  const [balance, setBalance] = useState("0");

  const [depositTime, setDepositTime] = useState(null);
  const [events, setEvents] = useState([]);
  const [darkMode, setDarkMode] = useState(true);
  const [quickAddress, setQuickAddress] = useState(localStorage.getItem("quickWithdraw"));
  const [canWithdraw, setCanWithdraw] = useState(false);
  const [withdrawCountdown, setWithdrawCountdown] = useState("");

  const [availableGrossStr, setAvailableGrossStr] = useState(null); // balance dispos (brut)
  const [maxWithdrawable, setMaxWithdrawable] = useState(null);     // net reçu si tu retires tout
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);

  // NEW: verrouillage dépôt tant qu’aucun retrait n’a été fait après le dernier dépôt
  const [depositLocked, setDepositLocked] = useState(false);
  const [depositLockMsg, setDepositLockMsg] = useState("");

  // Helpers
  const toLower = (s) => (typeof s === "string" ? s.toLowerCase() : s);
  const FEE_NUM = 10n;     // 0.1% = 10 / 10000
  const FEE_DEN = 10000n;

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (window.ethereum) {
      const p = new ethers.BrowserProvider(window.ethereum);
      setProvider(p);
    } else {
      setStatus("🦊 Please install MetaMask");
    }
  }, []);

  const loadUserActivity = async (addr, prov) => {
    try {
      const iface = new ethers.Interface(mixerAbi);

      // Récupère tous les logs du contrat
      const logs = await prov.getLogs({
        address: MIXER_ADDRESS,
        fromBlock: 0,
        toBlock: "latest",
      });

      let myEvents = [];
      let deposits = 0n;
      let withdrawalsGross = 0n;

      // NEW: pour le verrou dépôt
      let lastDepBlock = null;         // dernier bloc d'un dépôt de cet utilisateur
      let hadWithdrawalAfter = false;  // un retrait a-t-il eu lieu après ce dépôt ?

      for (const log of logs) {
        let parsed;
        try {
          parsed = iface.parseLog(log);
        } catch {
          continue;
        }

        if (parsed?.name === "Deposited") {
          const sender = parsed.args.sender;
          const amt = parsed.args.amount;
          if (toLower(sender) === toLower(addr)) {
            deposits += amt;
            myEvents.push({
              type: "Deposited",
              tx: log.transactionHash,
              sender,
              amount: ethers.formatUnits(amt, 18),
            });

            // track dernier bloc de dépôt pour cet utilisateur
            if (lastDepBlock === null || log.blockNumber > lastDepBlock) {
              lastDepBlock = log.blockNumber;
              hadWithdrawalAfter = false; // on réinitialise: on ne sait pas encore s'il y a eu retrait après CE dépôt
            }
          }
        } else if (parsed?.name === "Withdrawn") {
          // On identifie l'appelant (withdrawer) via tx.from
          const tx = await prov.getTransaction(log.transactionHash);
          const caller = tx?.from || "";
          if (toLower(caller) === toLower(addr)) {
            const net = parsed.args.amount;
            const fee = parsed.args.fee;
            const gross = net + fee; // ce qui a réellement été déduit de ta balance
            withdrawalsGross += gross;

            myEvents.push({
              type: "Withdrawn",
              tx: log.transactionHash,
              receiver: parsed.args.receiver,
              amount: ethers.formatUnits(gross, 18),
            });

            // Si ce retrait est postérieur au dernier dépôt, on lève le verrou
            if (lastDepBlock !== null && log.blockNumber > lastDepBlock) {
              hadWithdrawalAfter = true;
            }
          }
        }
      }

      // Balance dispo (brut) cumulée côté UI
      let availableGross = deposits - withdrawalsGross;
      if (availableGross < 0n) availableGross = 0n;

      // Si on retire tout en 1 tx, le receveur touchera:
      const feeAll = (availableGross * FEE_NUM) / FEE_DEN;
      const maxNet = availableGross - feeAll;

      setAvailableGrossStr(ethers.formatUnits(availableGross, 18));
      setMaxWithdrawable(ethers.formatUnits(maxNet, 18));
      setEvents(myEvents.reverse());

      // NEW: règle "un seul dépôt puis retrait obligatoire avant nouveau dépôt"
      if (lastDepBlock !== null && !hadWithdrawalAfter) {
        setDepositLocked(true);
        setDepositLockMsg("🔒 Deposit disabled: make a withdrawal before depositing again. Withdrawal available 24h after the last deposit ✅");
      } else {
        setDepositLocked(false);
        setDepositLockMsg("");
      }
    } catch (err) {
      console.error(err);
      setStatus("❌ Error while loading activity: " + err.message);
    }
  };

  const connect = async () => {
    try {
      const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
      const sgnr = await provider.getSigner();
      const network = await provider.getNetwork();
      if (network.chainId !== 1n) {
        setStatus("❌ Please connect to the Ethereum Mainnet");
        return;
      }

      setSigner(sgnr);
      setAddress(accs[0]);
      setStatus("✅ Wallet connected");

      const prvx = new ethers.Contract(PRVX_ADDRESS, prvxAbi, sgnr);
      const bal = await prvx.balanceOf(accs[0]);
      setBalance(ethers.formatUnits(bal, 18));

      // Logique 24h basée sur le dernier dépôt du contrat
      const mixer = new ethers.Contract(MIXER_ADDRESS, mixerAbi, sgnr);
      const [_, timestamp] = await mixer.getDeposit(accs[0]);

      if (timestamp > 0n) {
        const time = Number(timestamp);
        const depositDate = new Date(time * 1000);
        setDepositTime(depositDate.toLocaleString());

        const now = Math.floor(Date.now() / 1000);
        const diff = now - time;

        if (diff >= 86400) {
          setCanWithdraw(true);
          setWithdrawCountdown("");
        } else {
          const remaining = 86400 - diff;
          const hours = Math.floor(remaining / 3600);
          const minutes = Math.floor((remaining % 3600) / 60);
          setWithdrawCountdown(`Available in ${hours}h ${minutes}m`);
          setCanWithdraw(false);
        }
      } else {
        setDepositTime(null);
        setCanWithdraw(false);
        setWithdrawCountdown("");
      }

      // Historique filtré + calculs + verrou dépôt
      await loadUserActivity(accs[0], provider);
    } catch (err) {
      console.error(err);
      setStatus("❌ Connection error: " + err.message);
    }
  };

  const approveAndDeposit = async () => {
    try {
      if (depositLocked) {
        setStatus("❌ Deposit blocked: make a withdrawal first.");
        return;
      }

      const amt = ethers.parseUnits(amount || "0", 18);
      const prvx = new ethers.Contract(PRVX_ADDRESS, prvxAbi, signer);
      const mixer = new ethers.Contract(MIXER_ADDRESS, mixerAbi, signer);

      setStatus("⏳ Approving...");
      const approveTx = await prvx.approve(MIXER_ADDRESS, amt);
      await approveTx.wait();

      setStatus("✅ Approved. Depositing...");
      const depositTx = await mixer.deposit(amt);
      await depositTx.wait();

      setStatus("✅ Deposit successful!");
      await connect(); // refresh
    } catch (err) {
      console.error(err);
      setStatus("❌ Error: " + err.message);
    }
  };

  const withdraw = async () => {
    try {
      const recipient = prompt("Withdrawal address:");
      if (!recipient) return;

      const amt = ethers.parseUnits(amount || "0", 18);
      const mixer = new ethers.Contract(MIXER_ADDRESS, mixerAbi, signer);

      setStatus("⏳ Withdrawing...");
      const tx = await mixer.withdraw(recipient, amt);
      await tx.wait();

      setStatus("✅ Withdrawal successful!");
      await connect(); // refresh (déverrouille le dépôt)
    } catch (err) {
      console.error(err);
      setStatus("❌ Error: " + err.message);
    }
  };

  const quickWithdraw = async () => {
    try {
      if (!quickAddress) return setStatus("❌ No quick address set");
      const amt = ethers.parseUnits(amount || "0", 18);
      const mixer = new ethers.Contract(MIXER_ADDRESS, mixerAbi, signer);

      setStatus("⏳ Quick withdrawing...");
      const tx = await mixer.withdraw(quickAddress, amt);
      await tx.wait();

      setStatus("✅ Quick withdrawal successful!");
      await connect(); // refresh (déverrouille le dépôt)
    } catch (err) {
      console.error(err);
      setStatus("❌ Error: " + err.message);
    }
  };

  const defineQuickWithdrawAddress = () => {
    const input = prompt("New quick withdrawal address:");
    if (input && ethers.isAddress(input)) {
      localStorage.setItem("quickWithdraw", input);
      setQuickAddress(input);
      setStatus("✅ Quick address saved!");
    } else {
      setStatus("❌ Invalid address");
    }
  };

  return (
    <div style={{
      display: "flex",
      flexDirection: windowWidth < 768 ? "column" : "row",
      width: "100vw",
      fontFamily: "Arial",
      color: darkMode ? "#fff" : "#000",
      background: darkMode ? "#111" : "#f4f4f4",
      minHeight: "100vh"
    }}>
      <div style={{ flex: 1, padding: "2rem" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: "1rem" }}>
          <img src={logo} alt="PrivacyX Logo" style={{ height: "36px", marginRight: "0.75rem" }} />
          <h1 style={{ color: "#4befa0", margin: 0, fontSize: "1.8rem" }}>PRVX Mixer</h1>
        </div>

        <button onClick={() => setDarkMode(!darkMode)} style={{ marginBottom: "1rem" }}>
          🌓 Mode {darkMode ? "Light" : "Dark"}
        </button>
        <p>{status}</p>

        {!address && <button onClick={connect}>🔌 Connect MetaMask</button>}

        {address && (
          <>
            <p>👤 Connected address: {address}</p>
            <p>💰 PRVX Balance: {balance}</p>
            {depositTime && <p>🕒 Last deposit recorded: {depositTime}</p>}
            {quickAddress && <p>⚡ Quick address: {quickAddress}</p>}

            {/* Affichages clairs */}
            {availableGrossStr && <p>🏦 Available balance (gross): {availableGrossStr} PRVX</p>}
            {maxWithdrawable && <p>📤 Max you'll receive: {maxWithdrawable} PRVX (after 0.1% fee)</p>}

            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount of PRVX"
              style={{ padding: "0.5rem", marginBottom: "0.5rem", width: "100%", maxWidth: "300px" }}
            />

            {/* Message de verrou dépôt */}
            {depositLocked && (
              <p style={{ maxWidth: "600px", marginTop: 0 }}>
                {depositLockMsg}
              </p>
            )}

            <div style={{ marginTop: "0.5rem" }}>
              <button
                onClick={approveAndDeposit}
                disabled={depositLocked}
                style={{ width: "100%", maxWidth: "300px", opacity: depositLocked ? 0.5 : 1 }}
                title={depositLocked ? "Make a withdrawal before depositing again" : "Approve and deposit"}
              >
                📥 Approve + Deposit
              </button>

              <button
                onClick={withdraw}
                disabled={!canWithdraw}
                style={{ width: "100%", maxWidth: "300px", marginTop: "1rem", opacity: canWithdraw ? 1 : 0.5 }}
                title={!canWithdraw ? withdrawCountdown : "Available to withdraw"}
              >
                📤 Withdraw
              </button>

              <button
                onClick={quickWithdraw}
                disabled={!canWithdraw}
                style={{ width: "100%", maxWidth: "300px", marginTop: "1rem", opacity: canWithdraw ? 1 : 0.5 }}
                title={!canWithdraw ? withdrawCountdown : "Available to withdraw"}
              >
                ⚡ Quick Withdraw
              </button>
            </div>

            <button onClick={defineQuickWithdrawAddress} style={{ marginTop: "1rem", width: "100%", maxWidth: "300px" }}>
              ⚙️ Set quick withdraw address
            </button>

            {/* Titre mis à jour */}
            <h3 style={{ marginTop: "2rem" }}>📜 My History</h3>
            <ul>
              {events.map((e, i) => (
                <li key={i}>
                  [{e.type}] {e.amount} PRVX - {(e.sender || e.receiver || "").slice(0, 6)}... @ tx {e.tx.slice(0, 10)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div style={{
        flex: 1,
        backgroundColor: "#1a1a1a",
        display: "flex",
        justifyContent: "center",
        alignItems: "center"
      }}>
        <img
          src={logo3d}
          alt="3D Logo"
          style={{
            width: "60%",
            maxWidth: "400px",
            animation: "spin 60s linear infinite",
            transition: "transform 0.5s ease-in-out"
          }}
          className="logo3d"
        />
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .logo3d:hover {
          animation-duration: 8s !important;
          transform: scale(1.05);
        }
      `}</style>
    </div>
  );
}

export default App;


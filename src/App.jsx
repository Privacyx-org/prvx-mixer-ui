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

  useEffect(() => {
    if (window.ethereum) {
      const provider = new ethers.BrowserProvider(window.ethereum);
      setProvider(provider);
    } else {
      setStatus("🦊 Please install MetaMask");
    }
  }, []);

  const connect = async () => {
    try {
      const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
      const signer = await provider.getSigner();
      const network = await provider.getNetwork();
      if (network.chainId !== 1n) {
        setStatus("❌ Please connect to the Ethereum Mainnet");
        return;
      }

      setSigner(signer);
      setAddress(accs[0]);
      setStatus("✅ Wallet connected");

      const prvx = new ethers.Contract(PRVX_ADDRESS, prvxAbi, signer);
      const bal = await prvx.balanceOf(accs[0]);
      setBalance(ethers.formatUnits(bal, 18));

      const mixer = new ethers.Contract(MIXER_ADDRESS, mixerAbi, signer);
      const [_, timestamp] = await mixer.getDeposit(accs[0]);
      if (timestamp > 0n) {
        const time = Number(timestamp);
        const depositDate = new Date(time * 1000);
        setDepositTime(depositDate.toLocaleString());

        const now = Math.floor(Date.now() / 1000);
        const diff = now - time;

        if (diff >= 86400) {
          setCanWithdraw(true);
        } else {
          const remaining = 86400 - diff;
          const hours = Math.floor(remaining / 3600);
          const minutes = Math.floor((remaining % 3600) / 60);
          setWithdrawCountdown(`Available in ${hours}h ${minutes}m`);
          setCanWithdraw(false);
        }
      }

      const logs = await provider.getLogs({ fromBlock: "earliest", address: MIXER_ADDRESS });
      const iface = new ethers.Interface(mixerAbi);
      const parsed = logs.map(log => {
        try {
          const evt = iface.parseLog(log);
          return {
            type: evt.name,
            sender: evt.args.sender,
            amount: ethers.formatUnits(evt.args.amount, 18),
            tx: log.transactionHash
          };
        } catch {
          return null;
        }
      }).filter(e => e);
      setEvents(parsed.reverse());

    } catch (err) {
      console.error(err);
      setStatus("❌ Connection error: " + err.message);
    }
  };

  const approveAndDeposit = async () => {
    try {
      const amt = ethers.parseUnits(amount, 18);
      const prvx = new ethers.Contract(PRVX_ADDRESS, prvxAbi, signer);
      const mixer = new ethers.Contract(MIXER_ADDRESS, mixerAbi, signer);

      setStatus("⏳ Approving...");
      const approveTx = await prvx.approve(MIXER_ADDRESS, amt);
      await approveTx.wait();

      setStatus("✅ Approved. Depositing...");
      const depositTx = await mixer.deposit(amt);
      await depositTx.wait();

      setStatus("✅ Deposit successful!");
      connect();
    } catch (err) {
      console.error(err);
      setStatus("❌ Error: " + err.message);
    }
  };

  const withdraw = async () => {
    try {
      const recipient = prompt("Withdrawal address:");
      if (!recipient) return;

      const amt = ethers.parseUnits(amount, 18);
      const mixer = new ethers.Contract(MIXER_ADDRESS, mixerAbi, signer);

      setStatus("⏳ Withdrawing...");
      const tx = await mixer.withdraw(recipient, amt);
      await tx.wait();

      setStatus("✅ Withdrawal successful!");
    } catch (err) {
      console.error(err);
      setStatus("❌ Error: " + err.message);
    }
  };

  const quickWithdraw = async () => {
    try {
      if (!quickAddress) return setStatus("❌ No quick address set");
      const amt = ethers.parseUnits(amount, 18);
      const mixer = new ethers.Contract(MIXER_ADDRESS, mixerAbi, signer);
      setStatus("⏳ Quick withdrawing...");
      const tx = await mixer.withdraw(quickAddress, amt);
      await tx.wait();
      setStatus("✅ Quick withdrawal successful!");
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
      flexDirection: "row",
      width: "100vw",
      fontFamily: "Arial",
      color: darkMode ? "#fff" : "#000",
      background: darkMode ? "#111" : "#f4f4f4",
      minHeight: "100vh"
    }}>
      {/* Left column */}
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
            {depositTime && <p>🕒 Deposit recorded: {depositTime}</p>}
            {quickAddress && <p>⚡ Quick address: {quickAddress}</p>}

            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount of PRVX"
              style={{ padding: "0.5rem", marginRight: "1rem" }}
            />

            <div style={{ marginTop: "1rem" }}>
              <button onClick={approveAndDeposit}>📥 Approve + Deposit</button>
              <button onClick={withdraw} disabled={!canWithdraw} style={{ marginLeft: "1rem", opacity: canWithdraw ? 1 : 0.5 }} title={!canWithdraw ? withdrawCountdown : "Available"}>
                📤 Withdraw
              </button>
              <button onClick={quickWithdraw} disabled={!canWithdraw} style={{ marginLeft: "1rem", opacity: canWithdraw ? 1 : 0.5 }} title={!canWithdraw ? withdrawCountdown : "Available"}>
                ⚡ Quick Withdraw
              </button>
            </div>

            <button onClick={defineQuickWithdrawAddress} style={{ marginTop: "1rem" }}>
              ⚙️ Set quick withdraw address
            </button>

            <h3 style={{ marginTop: "2rem" }}>📜 History</h3>
            <ul>
              {events.map((e, i) => (
                <li key={i}>[{e.type}] {e.amount} PRVX - {e.sender.slice(0, 6)}... @ tx {e.tx.slice(0, 10)}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Right column with animation */}
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


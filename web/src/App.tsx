import { Component, type ErrorInfo, type ReactNode } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import {
  Check,
  CircleDollarSign,
  CreditCard,
  LayoutGrid,
  ShieldCheck,
  Store,
  Wallet,
  UserRound,
} from 'lucide-react';
import { configured, manifest } from './lib/runtime';
import { Notice } from './components';
import {
  Market,
  MerchantPage,
  BuyPage,
  CardsPage,
  CardPage,
  ExitPage,
  CommissionPage,
  TransactionPage,
} from './pages/Consumer';
import { BusinessGate, ProfilePage, UserLabel } from './pages/Profile';
import { MerchantConsole, PayPage } from './pages/Merchant';

class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* shown to user; no remote logging */
  }
  render() {
    return this.state.error ? (
      <Notice tone="danger">页面无法加载：{this.state.error}</Notice>
    ) : (
      this.props.children
    );
  }
}
function WalletButton() {
  const { address, chainId } = useAccount();
  const { connect, connectors, error, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, error: switchError } = useSwitchChain();
  return (
    <div className="wallet-control">
      {!address ? (
        <button
          className="primary"
          disabled={isPending}
          onClick={() => connectors[0] && connect({ connector: connectors[0] })}
        >
          <Wallet size={16} />
          {isPending ? '连接中…' : '连接钱包'}
        </button>
      ) : chainId !== manifest.chainId ? (
        <button className="primary" onClick={() => switchChain({ chainId: manifest.chainId })}>
          切换到 {manifest.networkName}
        </button>
      ) : (
        <button className="wallet-address" onClick={() => disconnect()} title="点击断开连接">
          <span className="avatar" />
          <UserLabel account={address} />
          <Check size={14} />
        </button>
      )}
      {(error || switchError) && (
        <span className="wallet-error">{(error ?? switchError)?.message.split('\n')[0]}</span>
      )}
    </div>
  );
}
export default function App() {
  const location = useLocation();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span className="brand-mark">
            <ShieldCheck size={25} />
          </span>
          <span>
            安心充<small>ANXINCHONG</small>
          </span>
        </a>
        <div className="nav-label">我的工作台</div>
        <nav>
          {[
            { to: '/', icon: LayoutGrid, label: '商家市场' },
            { to: '/cards', icon: CreditCard, label: '我的会员卡' },
            { to: '/merchant-console', icon: Store, label: '商家后台' },
            { to: '/commissions', icon: CircleDollarSign, label: '分佣记录' },
            { to: '/profile', icon: UserRound, label: '用户资料' },
          ].map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'}>
              <item.icon size={18} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="side-note">
            <ShieldCheck size={20} />
            <strong>每笔资金都有去向</strong>
            <p>
              预付款由合约托管
              <br />
              消费与退出规则链上执行
            </p>
          </div>
          <div className="built-on">
            <span className="monad-glyph">◈</span> Built on Monad
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            安心充 <span>/</span>{' '}
            {location.pathname.startsWith('/merchant-console') ? '商家工作台' : '消费工作台'}
          </div>
          <div className="topbar-actions">
            <span className="network-pill">
              <i />
              {manifest.networkName}
            </span>
            <WalletButton />
          </div>
        </header>
        <main>
          {manifest.isMockAsset && <Notice>当前使用本地链与 Mock USDC，仅供开发测试。</Notice>}
          {!configured && (
            <Notice>
              Monad
              测试网合约尚未部署。页面已接入链上接口，部署后即可查询和操作，当前不显示模拟资产或虚构交易。
            </Notice>
          )}
          <Boundary key={location.pathname}>
            <Routes>
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/" element={<Market />} />
              <Route path="/merchant/:id" element={<MerchantPage />} />
              <Route
                path="/buy/:vault/:id"
                element={
                  <BusinessGate>
                    <BuyPage />
                  </BusinessGate>
                }
              />
              <Route path="/cards" element={<CardsPage />} />
              <Route
                path="/cards/:vault/:id"
                element={
                  <BusinessGate>
                    <CardPage />
                  </BusinessGate>
                }
              />
              <Route
                path="/cards/:vault/:id/exit"
                element={
                  <BusinessGate>
                    <ExitPage />
                  </BusinessGate>
                }
              />
              <Route
                path="/merchant-console"
                element={
                  <BusinessGate>
                    <MerchantConsole />
                  </BusinessGate>
                }
              />
              <Route
                path="/pay"
                element={
                  <BusinessGate>
                    <PayPage />
                  </BusinessGate>
                }
              />
              <Route path="/commissions" element={<CommissionPage />} />
              <Route path="/tx/:hash" element={<TransactionPage />} />
              <Route path="*" element={<Notice>页面不存在，请通过左侧菜单进入。</Notice>} />
            </Routes>
          </Boundary>
          <footer>
            安心充 · 预付有约，消费安心 <span>测试资产无真实货币价值</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

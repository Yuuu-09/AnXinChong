import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  ArrowUpRight,
  BadgePercent,
  Check,
  ShieldCheck,
  Store,
  Ticket,
  Wallet,
} from 'lucide-react';
import { erc20Abi, isHash, type Address, type Hex } from 'viem';
import { parseAmount } from '@anxinchong/protocol/math';
import {
  Amount,
  Empty,
  History,
  Loading,
  Notice,
  QueryError,
  Title,
  TxStatus,
  money,
  useRead,
  useVault,
  useFactoryRead,
} from '../components';
import {
  configured,
  manifest,
  parseId,
  publicClient,
  queryScope,
  readVault,
  readFactory,
  allMerchants,
  totalMerchantEscrow,
  mapConcurrent,
  consumerCards,
  shortAddress,
  type Merchant,
  type Plan,
  type Membership,
  type PurchaseQuote,
  type ExitQuote,
} from '../lib/runtime';
import { UserLabel } from './Profile';
import { useTransactions } from '../lib/transactions';
import BillScanner from '../BillScanner';
import { ScanLine } from 'lucide-react';

type PageResult = readonly [readonly bigint[], bigint];
function useMembershipExit(vault: Address, id: bigint) {
  return useQuery({
    queryKey: [...queryScope, vault, 'membership-exit-state', id],
    enabled: configured,
    staleTime: 0,
    queryFn: async () => {
      let membership = await readVault<Membership>(vault, 'getMembership', [id]);
      let quote: ExitQuote | undefined;
      if (membership.lifecycle === 0) {
        try {
          quote = await readVault<ExitQuote>(vault, 'previewExit', [id]);
        } catch (error) {
          // Exit may be confirmed between these reads (including in another tab).
          // Only a confirmed closed account replaces the preview error.
          membership = await readVault<Membership>(vault, 'getMembership', [id]);
          if (membership.lifecycle !== 1) throw error;
        }
      }
      return { membership, quote };
    },
  });
}
function Pagination({
  page,
  setPage,
  count,
}: {
  page: number;
  setPage: (n: number) => void;
  count: number;
}) {
  return (
    <div className="pagination">
      <button className="secondary" disabled={!page} onClick={() => setPage(page - 1)}>
        上一页
      </button>
      <span>第 {page + 1} 页</span>
      <button className="secondary" disabled={count < 20} onClick={() => setPage(page + 1)}>
        下一页
      </button>
    </div>
  );
}

export function Market() {
  const [page, setPage] = useState(0);
  const summary = useFactoryRead<bigint>('merchantCount');
  const escrow = useQuery({
    queryKey: [...queryScope, 'all-merchant-escrow'],
    enabled: configured,
    queryFn: totalMerchantEscrow,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const shops = useQuery({
    queryKey: [...queryScope, 'merchants', page],
    enabled: configured,
    queryFn: async () => {
      const [ids] = await readFactory<PageResult>('listMerchants', [BigInt(page * 20), 20n]);
      return Promise.all(
        ids.map(async (id) => {
          const shop = await readFactory<Merchant>('getMerchant', [id]);
          return { id, ...shop };
        }),
      );
    },
  });
  return (
    <>
      <Title
        eyebrow="PREPAY WITH CONFIDENCE"
        title="预付有约，消费安心"
        description="发现会员优惠，让每一次消费都清楚、可查、有保障。"
      />
      <section className="hero">
        <div>
          <span className="hero-badge">
            <ShieldCheck size={15} /> 资金托管 · 按次结算
          </span>
          <h2>
            优惠先约定
            <br />
            资金随消费释放。
          </h2>
          <p>
            购买会员计划，预付款留在合约中。
            <br />
            双方确认消费后，商家才能获得对应收入。
          </p>
          <Link className="hero-link" to="/cards">
            查看我的会员卡 <ArrowRight size={17} />
          </Link>
        </div>
        <div className="hero-card">
          <div className="hero-card-top">
            <ShieldCheck size={24} />
            <span>安心充会员账户</span>
            <span>◈</span>
          </div>
          <div className="hero-card-number">资金由合约托管</div>
          <div className="hero-card-rule">
            <span>
              <Check size={14} /> 双方签名确认
            </span>
            <span>
              <Check size={14} /> 规则内自主退出
            </span>
          </div>
          <div className="hero-card-bottom">
            <span>ANXINCHONG</span>
            <span>MONAD TESTNET</span>
          </div>
        </div>
      </section>
      <section className="stats-grid">
        <div className="stat">
          <span className="stat-icon">
            <Wallet size={19} />
          </span>
          <div>
            <span>全部商家托管余额</span>
            <strong>
              <Amount value={escrow.isError ? undefined : escrow.data} />
            </strong>
            <small>消费者尚未使用的预付款</small>
          </div>
        </div>
        <div className="stat">
          <span className="stat-icon">
            <Store size={19} />
          </span>
          <div>
            <span>已注册商家</span>
            <strong>
              {summary.data?.toString() ?? '—'}
              <small> 家</small>
            </strong>
          </div>
        </div>
        <div className="stat">
          <span className="stat-icon">
            <BadgePercent size={19} />
          </span>
          <div>
            <span>会员优惠方式</span>
            <strong>
              储值折扣 <small>/</small> 按次服务
            </strong>
          </div>
        </div>
      </section>
      {summary.error && <QueryError error={summary.error} />}
      {escrow.error && <QueryError error={escrow.error} retry={() => void escrow.refetch()} />}
      <div className="section-heading">
        <div>
          <h2>发现商家</h2>
          <p>选择店铺，查看已约定的优惠与退款规则</p>
        </div>
        <span className="tag">链上公开计划</span>
      </div>
      {shops.isLoading ? (
        <Loading />
      ) : shops.error ? (
        <QueryError error={shops.error} retry={() => void shops.refetch()} />
      ) : !shops.data?.length ? (
        <div className="panel">
          <Empty title={configured ? '还没有商家入驻' : '等待首批商家上线'}>
            商家注册并发布计划后，会在这里展示。
            <br />
            <Link className="text-link" to="/merchant-console">
              进入商家后台 <ArrowUpRight size={13} />
            </Link>
          </Empty>
        </div>
      ) : (
        <>
          <div className="shop-grid">
            {shops.data.map((shop) => (
              <Link className="shop-card" key={shop.id.toString()} to={`/merchant/${shop.id}`}>
                <div className="shop-art">
                  <Store size={42} />
                  <span>#{shop.id.toString().padStart(3, '0')}</span>
                </div>
                <div className="shop-body">
                  <div className="row-between">
                    <h3>{shop.name}</h3>
                    <span className="tag">已注册</span>
                  </div>
                  <p>{shop.description || '查看店铺的会员优惠计划'}</p>
                  <div className="shop-bottom">
                    <span>独立金库 {shortAddress(shop.vault)}</span>
                    <span>
                      查看计划 <ArrowRight size={15} />
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
          <Pagination page={page} setPage={setPage} count={shops.data.length} />
        </>
      )}
    </>
  );
}
function PlanCard({ id, plan, vault }: { id: bigint; plan: Plan; vault: Address }) {
  return (
    <article className="panel plan-card">
      <div className="row-between">
        <span className="tag">{plan.mode === 0 ? '储值优惠' : '次数套餐'}</span>
        <small>版本 {plan.version.toString()}</small>
      </div>
      <h3>{plan.name}</h3>
      <div className="plan-price">
        {plan.mode === 0 ? (
          <>
            {Number(plan.discountBps) / 1000}
            <small> 折消费</small>
          </>
        ) : (
          <>
            <Amount value={plan.saleUnitPrice * plan.minUnits} />
            <small> / {plan.minUnits.toString()} 次</small>
          </>
        )}
      </div>
      <p>
        {plan.description ||
          (plan.mode === 0
            ? '消费按固定折扣扣款，退出时补回已享优惠。'
            : '按固定次数购买整张套餐，退出时按已用次数恢复原价。')}
      </p>
      <div className="detail-line">
        <span>{plan.mode === 0 ? '最低充值' : '套餐次数'}</span>
        <strong>
          {plan.mode === 0 ? `${money(plan.minDeposit)} USDC` : `${plan.minUnits} 次`}
        </strong>
      </div>
      {plan.mode === 1 && (
        <div className="detail-line">
          <span>单次原价</span>
          <Amount value={plan.listUnitPrice} />
        </div>
      )}
      <Link className="primary wide" to={`/buy/${vault}/${id}`}>
        查看并购买 <ArrowRight size={16} />
      </Link>
    </article>
  );
}
export function MerchantPage() {
  const id = parseId(useParams().id);
  const [page, setPage] = useState(0);
  const shop = useFactoryRead<Merchant>('getMerchant', [id]);
  const vault = shop.data?.vault;
  const plans = useQuery({
    queryKey: [...queryScope, vault, 'plans', id, page],
    enabled: configured && !!vault,
    queryFn: async () => {
      const [ids] = await readVault<PageResult>(vault!, 'listMerchantPlans', [
        id,
        BigInt(page * 20),
        20n,
      ]);
      return Promise.all(
        ids.map(async (id) => ({
          id,
          plan: await readVault<Plan>(vault!, 'getPlanVersion', [id]),
        })),
      );
    },
  });
  return (
    <>
      <Title title={shop.data?.name ?? '商家主页'} description={shop.data?.description} />
      {vault && (
        <p className="muted wrap">
          商家独立金库：<code>{vault}</code>
        </p>
      )}
      {shop.error && <QueryError error={shop.error} />}
      <div className="section-heading">
        <h2>在售会员计划</h2>
        <span className="tag">购买时固定条款</span>
      </div>
      {plans.isLoading ? (
        <Loading />
      ) : plans.error ? (
        <QueryError error={plans.error} />
      ) : (
        <>
          <div className="shop-grid">
            {plans.data
              ?.filter((p) => p.plan.active)
              .map((p) => (
                <PlanCard key={p.id.toString()} {...p} vault={vault!} />
              ))}
          </div>
          {!plans.data?.some((p) => p.plan.active) && (
            <Empty title="本页没有在售计划">可以查看下一页，或等待商家发布。</Empty>
          )}
          <Pagination page={page} setPage={setPage} count={plans.data?.length ?? 0} />
        </>
      )}
    </>
  );
}
export function BuyPage() {
  const navigate = useNavigate();
  const vault = useVault();
  const id = parseId(useParams().id);
  const { address } = useAccount();
  const tx = useTransactions(vault);
  const plan = useRead<Plan>('getPlanVersion', [id], true, vault);
  const [input, setInput] = useState('');
  let quantity = 0n,
    inputError = '';
  try {
    if (plan.data?.mode === 1) quantity = plan.data.minUnits;
    else if (plan.data?.mode === 0 && input) quantity = parseAmount(input);
  } catch (e) {
    inputError = (e as Error).message;
  }
  const quote = useRead<PurchaseQuote>(
    'quotePurchase',
    [id, quantity, address],
    !!address && quantity > 0n,
    vault,
  );
  async function purchase() {
    if (!quote.data || !address) return;
    const q = quote.data;
    const receipt = await tx.run(async () => {
      const allowance = await publicClient.readContract({
        address: manifest.asset,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, vault],
      });
      if (allowance < q.principal) await tx.send('approve', [vault, q.principal], true);
      return tx.send('buy', [id, quantity, q.termsHash]);
    });
    if (receipt) navigate('/cards', { replace: true });
  }
  return (
    <>
      <Title title="购买会员计划" description="付款前，请确认优惠、退出规则和分佣信息。" />
      {plan.error ? (
        <QueryError error={plan.error} />
      ) : plan.isLoading ? (
        <Loading />
      ) : (
        plan.data && (
          <div className="two-column">
            <section className="panel">
              <span className="tag">{plan.data.mode === 0 ? '储值计划' : '次数计划'}</span>
              <h2>{plan.data.name}</h2>
              <p className="muted">{plan.data.description}</p>
              {plan.data.mode === 0 ? (
                <label className="field">
                  <span>充值金额（USDC）</span>
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={money(plan.data.minDeposit)}
                    inputMode="decimal"
                  />
                </label>
              ) : (
                <>
                  <div className="detail-line">
                    <span>固定次数</span>
                    <strong>{plan.data.minUnits.toString()} 次 / 张</strong>
                  </div>
                  <div className="detail-line">
                    <span>单次优惠价</span>
                    <Amount value={plan.data.saleUnitPrice} />
                  </div>
                </>
              )}
              {inputError && <Notice tone="danger">{inputError}</Notice>}
              {quote.error && <QueryError error={quote.error} />}
              <div className="detail-line">
                <span>购买本金</span>
                <Amount value={quote.data?.principal} />
              </div>
              <div className="detail-line">
                <span>渠道费率</span>
                <strong>{quote.data ? `${Number(quote.data.channelBps) / 100}%` : '—'}</strong>
              </div>
              <div className="detail-line">
                <span>邀请费率</span>
                <strong>{quote.data ? `${Number(quote.data.referralBps) / 100}%` : '—'}</strong>
              </div>
              {quote.data && (
                <div className="detail-line">
                  <span>邀请者</span>
                  <code>{shortAddress(quote.data.referralRecipient)}</code>
                </div>
              )}
              <button
                className="primary wide"
                disabled={!quote.data || tx.busy || quote.isFetching || !plan.data.active}
                onClick={() => void purchase()}
              >
                {tx.busy ? '处理中…' : '授权并购买'}
              </button>
              <TxStatus tx={tx} />
            </section>
            <aside className="panel rules">
              <ShieldCheck size={26} />
              <h3>资金如何使用</h3>
              <p>购买时，本金全额进入该商家的独立金库，不提前分账。</p>
              <p className="wrap">
                金库地址：<code>{vault}</code>
              </p>
              <h3>退出时如何退款</h3>
              <p>
                {plan.data.mode === 0
                  ? '可退金额为本金减去累计原价消费，最低为零；历史优惠从剩余本金中补回。'
                  : '可退金额为购买本金减去已用次数乘以单次原价，最低为零。'}
              </p>
              <p>
                补差以剩余本金为上限，不额外追缴。主动退出后剩余权益作废；可退金额为零时仍可选择继续使用。
              </p>
              <small>渠道费和邀请费只从实际释放给商家的收入中分配，退款金额不另收费。</small>
            </aside>
          </div>
        )
      )}
      {!address && <Notice>连接消费者钱包后可查看购买报价。</Notice>}
    </>
  );
}
function MembershipCard({ id, card, vault }: { id: bigint; card: Membership; vault: Address }) {
  const shop = useFactoryRead<Merchant>('getMerchant', [card.merchantId]);
  const plan = useRead<Plan>('getPlanVersion', [card.planVersionId], true, vault);
  return (
    <Link
      className={`panel membership-card ${card.mode === 0 ? 'card-stored' : 'card-count'}`}
      to={`/cards/${vault}/${id}`}
    >
      <div className="row-between">
        <span className="membership-type">
          {card.mode === 0 ? (
            <Wallet size={16} aria-hidden="true" />
          ) : (
            <Ticket size={16} aria-hidden="true" />
          )}
          {card.mode === 0 ? '储值卡 · 按金额消费' : '次数卡 · 按次数使用'}
        </span>
        <small>账户 #{id.toString()}</small>
      </div>
      <div className="membership-icon">
        {card.mode === 0 ? (
          <Wallet size={30} aria-hidden="true" />
        ) : (
          <Ticket size={30} aria-hidden="true" />
        )}
      </div>
      <h3>{shop.data?.name ?? (shop.error ? '店铺名称暂时无法读取' : '正在读取店铺名称…')}</h3>
      <p className="membership-plan">
        {plan.data?.name ?? (plan.error ? '计划名称暂时无法读取' : '正在读取计划名称…')}
      </p>
      <small className="muted">独立金库 {shortAddress(vault)}</small>
      <p className="muted">
        {card.lifecycle === 1
          ? '已退出关闭'
          : card.remainingPrincipal === 0n
            ? '已耗尽'
            : card.mode === 0
              ? `${Number(card.discountBps) / 1000} 折消费`
              : `剩余 ${card.purchasedUnits - card.usedUnits} 次`}
      </p>
      <div className="row-between">
        <Amount value={card.remainingPrincipal} />
        <ArrowRight size={18} />
      </div>
    </Link>
  );
}
export function CardsPage() {
  const [scanning, setScanning] = useState(false);
  const { address } = useAccount();
  const [page, setPage] = useState(0);
  const cards = useQuery({
    queryKey: [...queryScope, 'cards', address, page],
    enabled: configured && !!address,
    queryFn: async () => {
      const accounts = await consumerCards(address!);
      return Promise.all(
        accounts.slice(page * 20, (page + 1) * 20).map(async ({ id, vault }) => ({
          id,
          vault,
          card: await readVault<Membership>(vault, 'getMembership', [id]),
        })),
      );
    },
  });
  return (
    <>
      <Title
        title="我的会员卡"
        description="每一笔购买独立记账，余额与权益实时可查。"
        action={
          <button className="primary" disabled={!configured} onClick={() => setScanning(true)}>
            <ScanLine size={17} />
            扫码消费
          </button>
        }
      />
      <BillScanner open={scanning} onClose={() => setScanning(false)} />
      {!address ? (
        <Empty title="连接钱包查看会员卡">你的会员账户直接从 Monad 链上读取。</Empty>
      ) : cards.isLoading ? (
        <Loading />
      ) : cards.error ? (
        <QueryError error={cards.error} />
      ) : !cards.data?.length ? (
        <Empty title="暂无会员账户">
          <Link className="text-link" to="/">
            去发现会员优惠 <ArrowRight size={14} />
          </Link>
        </Empty>
      ) : (
        <>
          <div className="shop-grid">
            {cards.data.map((c) => (
              <MembershipCard key={`${c.vault}:${c.id}`} {...c} />
            ))}
          </div>
          <Pagination page={page} setPage={setPage} count={cards.data.length} />
        </>
      )}
    </>
  );
}
export function CardPage() {
  const vault = useVault();
  const id = parseId(useParams().id);
  const { address } = useAccount();
  const tx = useTransactions(vault);
  const state = useMembershipExit(vault, id);
  const card = { ...state, data: state.data?.membership };
  const quote = state.data?.quote;
  return (
    <>
      <Title title={`会员账户 #${id}`} description="本金、消费与退出记录均以链上结果为准。" />
      <p className="muted wrap">
        所属金库：<code>{vault}</code>
      </p>
      {card.error ? (
        <QueryError error={card.error} />
      ) : card.isLoading ? (
        <Loading />
      ) : (
        card.data && (
          <>
            <section className="stats-grid">
              <div className="stat">
                <div>
                  <span>剩余托管本金</span>
                  <strong>
                    <Amount value={card.data.remainingPrincipal} />
                  </strong>
                </div>
              </div>
              <div className="stat">
                <div>
                  <span>累计原价消费 / 实际扣款</span>
                  <strong>
                    <Amount value={card.data.totalOriginalValue} symbol={false} /> /{' '}
                    <Amount value={card.data.totalActualSpend} symbol={false} />
                  </strong>
                </div>
              </div>
              <div className="stat">
                <div>
                  <span>当前可退金额</span>
                  <strong>
                    <Amount
                      value={card.data.lifecycle === 1 ? card.data.refundedAmount : quote?.refund}
                    />
                  </strong>
                </div>
              </div>
            </section>
            <section className="panel">
              <div className="row-between">
                <h2>
                  {card.data.lifecycle === 1
                    ? '账户已退出'
                    : card.data.remainingPrincipal === 0n
                      ? '账户已耗尽'
                      : card.data.mode === 0
                        ? `${Number(card.data.discountBps) / 1000} 折会员权益`
                        : `剩余 ${card.data.purchasedUnits - card.data.usedUnits} 次服务`}
                </h2>
                {card.data.lifecycle === 0 &&
                  address?.toLowerCase() === card.data.consumer.toLowerCase() && (
                    <Link className="secondary" to={`/cards/${vault}/${id}/exit`}>
                      退出与退款 <ArrowRight size={15} />
                    </Link>
                  )}
              </div>
              <div className="detail-line">
                <span>账户持有人</span>
                <code>{card.data.consumer}</code>
              </div>
              <div className="detail-line">
                <span>购买本金</span>
                <Amount value={card.data.initialPrincipal} />
              </div>
              <div className="detail-line">
                <span>商家已实际获得收入</span>
                <Amount value={card.data.merchantPaid} />
              </div>
              {card.data.lifecycle === 0 &&
                [card.data.consumer.toLowerCase(), card.data.merchantSigner.toLowerCase()].includes(
                  address?.toLowerCase() ?? '',
                ) && (
                  <>
                    <button
                      className="text-button"
                      disabled={tx.busy}
                      onClick={() =>
                        void tx.run(() => tx.send('invalidateNonce', [id, card.data!.nextNonce]))
                      }
                    >
                      撤销当前待结算账单（nonce {card.data.nextNonce.toString()}）
                    </button>
                    <TxStatus tx={tx} />
                  </>
                )}
            </section>
            <div className="panel">
              <h2>消费与资金记录</h2>
              {card.data && (
                <p>
                  持有人：
                  <UserLabel account={card.data.consumer} />
                </p>
              )}
              <History membershipId={id} vault={vault} />
            </div>
          </>
        )
      )}
    </>
  );
}
export function ExitPage() {
  const vault = useVault();
  const id = parseId(useParams().id);
  const { address } = useAccount();
  const tx = useTransactions(vault);
  const [zero, setZero] = useState(false);
  useEffect(() => setZero(false), [address, vault, id]);
  const state = useMembershipExit(vault, id);
  const card = state.data?.membership;
  const quote = state.data?.quote;
  const allowed =
    !!address && card?.consumer.toLowerCase() === address.toLowerCase() && card?.lifecycle === 0;
  return (
    <>
      <Title title="退出与退款" description="无需商家审批，按购买时约定的规则完成退出。" />
      <div className="two-column">
        <section className="panel">
          <h2>账户 #{id.toString()} 退出明细</h2>
          {state.isLoading ? (
            <Loading />
          ) : state.error ? (
            <QueryError error={state.error} retry={() => void state.refetch()} />
          ) : card?.lifecycle === 1 ? (
            <>
              <Notice tone="success">
                该账户已退出，实际退款 <Amount value={card.refundedAmount} />
              </Notice>
              <div className="detail-line">
                <span>退出补差</span>
                <Amount value={card.exitTopUp} />
              </div>
              {card.mode === 1 && (
                <div className="detail-line">
                  <span>退出时作废次数</span>
                  <span>{card.forfeitedUnits.toString()} 次</span>
                </div>
              )}
              <Link className="secondary wide" to={`/cards/${vault}/${id}`}>
                查看会员卡与历史记录
              </Link>
            </>
          ) : quote ? (
            <>
              {[
                ['剩余本金', quote.balance],
                ['应补回历史优惠', quote.compensation],
                ['实际补差', quote.actualTopUp],
              ].map(([label, value]) => (
                <div className="detail-line" key={String(label)}>
                  <span>{String(label)}</span>
                  <Amount value={value as bigint} />
                </div>
              ))}
              <div className="refund-total">
                <span>预计退款到账</span>
                <strong>
                  <Amount value={quote.refund} />
                </strong>
              </div>
              <div className="detail-line">
                <span>补差商家收入</span>
                <Amount value={quote.split.merchant} />
              </div>
              <div className="detail-line">
                <span>渠道收入</span>
                <Amount value={quote.split.channel} />
              </div>
              <div className="detail-line">
                <span>邀请收入</span>
                <Amount value={quote.split.referral} />
              </div>
              <Notice>
                退出后折扣资格
                {quote.forfeitedUnits > 0n ? `及剩余 ${quote.forfeitedUnits} 次服务` : ''}
                作废，待结算账单失效。
              </Notice>
              {quote.refund === 0n && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={zero}
                    onChange={(e) => setZero(e.target.checked)}
                  />
                  我确认退款为零，并主动放弃剩余权益。
                </label>
              )}
              <button
                className="primary wide"
                disabled={!allowed || tx.busy || state.isFetching || (quote.refund === 0n && !zero)}
                onClick={() => {
                  const q = quote;
                  void tx.run(() => tx.send('exit', [id, q.refund, q.refund === 0n && zero]));
                }}
              >
                {tx.busy
                  ? '退出处理中…'
                  : quote.refund === 0n
                    ? '确认零退款退卡'
                    : '按以上金额退出'}
              </button>
              <Link className="secondary wide" to={`/cards/${vault}/${id}`}>
                继续使用，返回会员卡
              </Link>
            </>
          ) : (
            <Notice>请先部署合约并连接账户持有人钱包。</Notice>
          )}
          <TxStatus tx={tx} />
        </section>
        <aside className="panel rules">
          <ShieldCheck size={26} />
          <h3>退出保护</h3>
          <p>
            交易携带当前预览的最低可接受退款额。如果提交前发生消费，导致可退金额降低，退出交易将失败。
          </p>
          <p>零退款不会自动退卡。只有你明确选择后，才会释放剩余本金并关闭账户。</p>
          <p>补差最多扣除账户剩余本金，不要求你额外补款。</p>
        </aside>
      </div>
    </>
  );
}
export function CommissionPage() {
  const { address } = useAccount();
  const stats = useQuery({
    queryKey: [...queryScope, 'recipient-stats', address],
    enabled: configured && !!address,
    queryFn: async () => {
      const amounts = await mapConcurrent(await allMerchants(), ({ shop }) =>
        readVault<readonly [bigint, bigint]>(shop.vault, 'getRecipientStats', [address]),
      );
      return amounts.reduce<readonly [bigint, bigint]>(
        ([channel, referral], [a, b]) => [channel + a, referral + b],
        [0n, 0n],
      );
    },
  });
  return (
    <>
      <Title title="分佣记录" description="查看当前钱包实际收到的渠道费与邀请费。" />
      {!address ? (
        <Empty title="连接收款钱包查看收入" />
      ) : (
        <>
          <div className="stats-grid">
            <div className="stat">
              <div>
                <span>累计渠道收入</span>
                <strong>
                  <Amount value={stats.data?.[0]} />
                </strong>
              </div>
            </div>
            <div className="stat">
              <div>
                <span>累计邀请收入</span>
                <strong>
                  <Amount value={stats.data?.[1]} />
                </strong>
              </div>
            </div>
          </div>
          {stats.error && <QueryError error={stats.error} />}
          <section className="panel">
            <h2>收入明细</h2>
            <History recipient={address} />
          </section>
        </>
      )}
    </>
  );
}
export function TransactionPage() {
  const raw = useParams().hash ?? '';
  const valid = isHash(raw);
  const hash = raw as Hex;
  const query = useQuery({
    queryKey: [...queryScope, 'receipt', raw],
    enabled: valid,
    refetchInterval: (q) => (q.state.data ? false : 4000),
    queryFn: async () => ({
      receipt: await publicClient.getTransactionReceipt({ hash }),
      transaction: await publicClient.getTransaction({ hash }),
    }),
  });
  return (
    <>
      <Title title="链上交易详情" description="查看交易回执与实际网络费用。" />
      {!valid ? (
        <Notice tone="danger">交易哈希无效</Notice>
      ) : (
        <section className="panel">
          <p className="wrap">
            <code>{hash}</code>
          </p>
          {query.isLoading ? (
            <Loading />
          ) : query.error ? (
            <QueryError error={query.error} retry={() => void query.refetch()} />
          ) : (
            query.data && (
              <>
                <div className="detail-line">
                  <span>执行状态</span>
                  <strong>
                    {query.data.receipt.status === 'success' ? '执行成功' : '链上回滚'}
                  </strong>
                </div>
                <div className="detail-line">
                  <span>所在区块</span>
                  <strong>{query.data.receipt.blockNumber.toString()}</strong>
                </div>
                <div className="detail-line">
                  <span>交易 Gas 上限</span>
                  <strong>{query.data.transaction.gas.toString()}</strong>
                </div>
                <div className="detail-line">
                  <span>回执 gasUsed</span>
                  <strong>{query.data.receipt.gasUsed.toString()}</strong>
                </div>
                <div className="detail-line">
                  <span>按 Gas 上限计算的费用（MON 最小单位）</span>
                  <strong>
                    {(query.data.transaction.gas * query.data.receipt.effectiveGasPrice).toString()}
                  </strong>
                </div>
              </>
            )
          )}
          {manifest.explorerUrl && (
            <a
              className="text-link"
              href={`${manifest.explorerUrl}/tx/${hash}`}
              target="_blank"
              rel="noreferrer"
            >
              在区块浏览器查看 <ArrowUpRight size={15} />
            </a>
          )}
        </section>
      )}
    </>
  );
}

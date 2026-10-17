import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus, Settings2, ShieldCheck } from 'lucide-react';
import BillShare from '../BillShare';
import { bytesToHex, getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { parseAmount, discounted } from '@anxinchong/protocol/math';
import {
  BILL_TYPES,
  billDomain,
  decodeEnvelope,
  encodeEnvelope,
  serviceHash,
  type Bill,
  type Envelope,
} from '@anxinchong/protocol/bill';
import {
  Amount,
  Empty,
  Field,
  History,
  Loading,
  Modal,
  Notice,
  QueryError,
  Title,
  TxStatus,
  useRead,
  useFactoryRead,
} from '../components';
import {
  configured,
  manifest,
  parseId,
  publicClient,
  queryScope,
  readVault,
  registeredVault,
  type Merchant,
  type MerchantStats,
  type Plan,
  type Membership,
  type Preview,
} from '../lib/runtime';
import { UserLabel, useProfile } from './Profile';
import { errorText, useTransactions } from '../lib/transactions';

const form = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
};
function bps(value: string) {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) throw new Error('费率或实付比例最多两位小数');
  const [a, b = ''] = value.split('.');
  const n = BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
  if (n > 10000n) throw new Error('比例不能超过 100%');
  return n;
}

type MemberSelection = { id: bigint; sequence: number };

function MerchantMemberRow({
  id,
  card,
  vault,
  onCreate,
  busy,
}: {
  id: bigint;
  card: Membership;
  vault: Address;
  onCreate: (id: bigint) => void;
  busy: boolean;
}) {
  const profile = useProfile(card.consumer);
  const plan = useRead<Plan>('getPlanVersion', [card.planVersionId], true, vault);
  const closed = card.lifecycle === 1;
  const exhausted =
    card.remainingPrincipal === 0n || (card.mode === 1 && card.usedUnits >= card.purchasedUnits);
  return (
    <tr>
      <td data-label="会员编号">
        <Link className="text-link" to={`/cards/${vault}/${id}`}>
          #{id.toString()}
        </Link>
      </td>
      <td data-label="会员昵称和 handle">
        {profile.error ? (
          <button className="text-button" onClick={() => void profile.refetch()}>
            资料读取失败，重试
          </button>
        ) : (
          <div className="member-identity" title={card.consumer}>
            <strong>{profile.data?.nickname ?? '正在读取昵称…'}</strong>
            <small>
              {profile.data?.handle
                ? `@${profile.data.handle}`
                : profile.isPending
                  ? '正在读取 handle…'
                  : '未设置 handle'}
            </small>
          </div>
        )}
      </td>
      <td data-label="已开通会员计划">
        <div className="member-plan">
          {plan.error ? (
            <button className="text-button" onClick={() => void plan.refetch()}>
              计划读取失败，重试
            </button>
          ) : (
            <strong>{plan.data?.name ?? '正在读取计划…'}</strong>
          )}
          <small>
            {closed
              ? '已退出'
              : exhausted
                ? '已耗尽'
                : card.mode === 0
                  ? '储值卡'
                  : `次数卡 · 剩余 ${card.purchasedUnits - card.usedUnits} 次`}
          </small>
        </div>
      </td>
      <td data-label="操作">
        <button
          className="secondary"
          disabled={busy || closed || exhausted}
          onClick={() => onCreate(id)}
        >
          {closed ? '已退出' : exhausted ? '已耗尽' : '创建消费'}
        </button>
      </td>
    </tr>
  );
}

function BillComposer({
  merchantId,
  vault,
  selection,
  onBusyChange,
}: {
  merchantId: bigint;
  vault: Address;
  selection: MemberSelection | null;
  onBusyChange: (busy: boolean) => void;
}) {
  const { address, chainId } = useAccount();
  const tx = useTransactions(vault);
  const [link, setLink] = useState('');
  const [membership, setMembership] = useState('');
  const section = useRef<HTMLElement>(null);
  const billForm = useRef<HTMLFormElement>(null);
  const storageKey = `anxinchong:draft:1:${manifest.chainId}:${vault}:${address}:${merchantId}`;
  useEffect(() => {
    setLink('');
    try {
      setLink(localStorage.getItem(storageKey) ?? '');
    } catch {
      /* optional draft */
    }
  }, [storageKey, chainId]);
  useEffect(() => {
    onBusyChange(tx.busy);
    return () => onBusyChange(false);
  }, [tx.busy, onBusyChange]);
  useEffect(() => {
    if (!selection) return;
    setMembership(selection.id.toString());
    billForm.current?.reset();
    setLink('');
    tx.reset();
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* optional draft */
    }
    section.current
      ?.querySelector<HTMLInputElement>('input[name="amount"]')
      ?.focus({ preventScroll: true });
    section.current?.scrollIntoView({
      block: 'start',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  }, [selection, storageKey]);
  async function create(event: FormEvent<HTMLFormElement>) {
    const values = form(event);
    await tx.run(async () => {
      const id = parseId(values.membership);
      const account = await readVault<Membership>(vault, 'getMembership', [id]);
      if (
        account.merchantId !== merchantId ||
        account.merchantSigner.toLowerCase() !== address?.toLowerCase()
      )
        throw new Error('该会员账户不属于当前商家签名地址');
      if (account.lifecycle === 1) throw new Error('账户已退出');
      if (new TextEncoder().encode(values.service).length > 120)
        throw new Error('服务说明最多 120 个 UTF-8 字节');
      const block = await publicClient.getBlock();
      const units = account.mode === 1 ? parseId(values.amount) : 0n;
      const original =
        account.mode === 0 ? parseAmount(values.amount) : units * account.listUnitPrice;
      const bill: Bill = {
        membershipId: id,
        termsHash: account.termsHash,
        merchantSigner: account.merchantSigner,
        consumer: account.consumer,
        mode: account.mode,
        originalValue: original,
        discountBps: account.mode === 0 ? account.discountBps : 0n,
        debitAmount:
          account.mode === 0
            ? discounted(original, account.discountBps)
            : units * account.saleUnitPrice,
        units,
        orderId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        nonce: account.nextNonce,
        issuedAt: block.timestamp,
        deadline: block.timestamp + 900n,
        serviceHash: serviceHash(values.service),
      };
      await readVault<Preview>(vault!, 'previewSettlement', [bill]);
      const signature = await tx.sign(bill);
      const envelope: Envelope = {
        schemaVersion: 1,
        chainId: manifest.chainId,
        verifyingContract: vault!,
        bill,
        merchantSignature: signature,
        serviceText: values.service,
      };
      const encoded = encodeEnvelope(envelope);
      const full = `${location.origin}${location.pathname}#/pay?vault=${vault}&bill=${encoded}`;
      setLink(full);
      try {
        localStorage.setItem(storageKey, full);
      } catch {
        /* link remains usable */
      }
    });
  }
  return (
    <section className="panel bill-composer" ref={section}>
      <div className="section-heading">
        <h2>创建消费账单</h2>
        <span className="tag">商家签名 → 消费者确认</span>
      </div>
      {selection && membership === selection.id.toString() && (
        <p className="muted" role="status">
          已选择会员账户 #{membership}，请填写本次消费内容。
        </p>
      )}
      <form ref={billForm} onSubmit={(e) => void create(e)}>
        <div className="form-grid">
          <label className="field">
            <span>会员账户 ID</span>
            <input
              name="membership"
              value={membership}
              placeholder="例如 1"
              inputMode="numeric"
              required
              disabled={tx.busy}
              onChange={(event) => {
                setMembership(event.target.value);
                setLink('');
                tx.reset();
                try {
                  localStorage.removeItem(storageKey);
                } catch {
                  /* optional draft */
                }
              }}
            />
          </label>
          <Field
            label="储值卡填消费原价，次数卡填次数"
            name="amount"
            placeholder="例如 200 或 3"
            required
          />
        </div>
        <Field label="服务说明" name="service" placeholder="例如：洗剪吹服务" required />
        <button className="primary" disabled={tx.busy || !configured}>
          <Plus size={16} />
          {tx.busy ? '签名中…' : '签名并生成账单'}
        </button>
      </form>
      <TxStatus tx={tx} />
      {link && (
        <BillShare
          key={link}
          link={link}
          onClose={() => {
            setLink('');
            tx.reset();
            try {
              if (localStorage.getItem(storageKey) === link) localStorage.removeItem(storageKey);
            } catch {
              /* optional draft */
            }
            billForm.current
              ?.querySelector<HTMLButtonElement>('button')
              ?.focus({ preventScroll: true });
          }}
        />
      )}
    </section>
  );
}

export function MerchantConsole() {
  const { address } = useAccount();
  const [mode, setMode] = useState(0);
  const [editor, setEditor] = useState<'profile' | 'plan' | null>(null);
  const [memberPage, setMemberPage] = useState(0);
  const [memberSelection, setMemberSelection] = useState<MemberSelection | null>(null);
  const [billBusy, setBillBusy] = useState(false);
  useEffect(() => {
    setMemberPage(0);
    setMemberSelection(null);
  }, [address]);
  useEffect(() => setEditor(null), [address]);
  const [page, setPage] = useState(0);
  const mid = useFactoryRead<bigint>('merchantOf', [address], !!address);
  const merchantId = mid.data ?? 0n;
  const shop = useFactoryRead<Merchant>('getMerchant', [merchantId], merchantId > 0n);
  const vault = shop.data?.vault;
  const tx = useTransactions(vault);
  const stats = useRead<MerchantStats>('getMerchantStats', [merchantId], merchantId > 0n, vault);
  const plans = useQuery({
    queryKey: [...queryScope, vault, 'console-plans', merchantId, page],
    enabled: configured && merchantId > 0n && !!vault,
    queryFn: async () => {
      const [ids] = await readVault<readonly [readonly bigint[], bigint]>(
        vault!,
        'listMerchantPlans',
        [merchantId, BigInt(page * 20), 20n],
      );
      return Promise.all(
        ids.map(async (id) => ({ id, ...(await readVault<Plan>(vault!, 'getPlanVersion', [id])) })),
      );
    },
  });
  const members = useQuery({
    queryKey: [...queryScope, vault, 'console-members', merchantId, memberPage],
    enabled: configured && merchantId > 0n && !!vault,
    refetchInterval: 5000,
    queryFn: async () => {
      const [ids] = await readVault<readonly [readonly bigint[], bigint]>(
        vault!,
        'listMerchantMemberships',
        [merchantId, BigInt(memberPage * 20), 20n],
      );
      return Promise.all(
        ids.map(async (id) => ({
          id,
          card: await readVault<Membership>(vault!, 'getMembership', [id]),
        })),
      );
    },
  });
  function profile(event: FormEvent<HTMLFormElement>) {
    const v = form(event);
    void tx.run(async () => {
      const receipt = await (merchantId
        ? tx.send('updateMerchantProfile', [
            merchantId,
            { name: v.name, description: v.description },
            getAddress(v.payout),
          ])
        : tx.send('registerMerchant', [
            { name: v.name, description: v.description },
            getAddress(v.payout),
          ]));
      if (receipt) setEditor(null);
      return receipt;
    });
  }
  function createPlan(event: FormEvent<HTMLFormElement>) {
    const v = form(event);
    void tx.run(async () => {
      const fixedUnits = mode === 1 ? v.fixedUnits?.trim() : undefined;
      if (
        mode === 1 &&
        (!fixedUnits ||
          !/^[1-9]\d*$/.test(fixedUnits) ||
          fixedUnits.length > 78 ||
          BigInt(fixedUnits) >= 2n ** 256n)
      ) {
        throw new Error('固定次数必须为正整数');
      }
      const receipt = await tx.send('createPlanVersion', [
        {
          merchantId,
          previousVersionId: v.previous ? BigInt(v.previous) : 0n,
          mode,
          name: v.name,
          description: v.description,
          minDeposit: mode === 0 ? parseAmount(v.minimum) : 0n,
          discountBps: mode === 0 ? bps(v.discount) : 0n,
          minUnits: mode === 1 ? BigInt(fixedUnits!) : 0n,
          listUnitPrice: mode === 1 ? parseAmount(v.original) : 0n,
          saleUnitPrice: mode === 1 ? parseAmount(v.sale) : 0n,
          channelRecipient: v.channel ? getAddress(v.channel) : zeroAddress,
          channelBps: bps(v.channelFee),
          referralBps: bps(v.referralFee),
        },
      ]);
      if (receipt) setEditor(null);
      return receipt;
    });
  }
  return (
    <>
      <Title
        title="商家工作台"
        description="发布会员优惠，创建消费账单，查看实际结算收入。"
        action={
          merchantId > 0n &&
          !!vault && (
            <button
              className="secondary"
              disabled={tx.busy}
              onClick={() => {
                tx.reset();
                setEditor('profile');
              }}
            >
              <Settings2 size={16} /> 店铺资料
            </button>
          )
        }
      />
      {!address ? (
        <Empty title="连接商家钱包开始使用">同一个钱包也可以作为消费者购买会员卡。</Empty>
      ) : (
        <>
          {mid.error && <QueryError error={mid.error} />}
          {!editor && <TxStatus tx={tx} />}
          {shop.error && <QueryError error={shop.error} />}
          {merchantId > 0n && !!vault && (
            <section className="stats-grid">
              <div className="stat">
                <div>
                  <span>消费者当前托管本金</span>
                  <strong>
                    <Amount value={stats.data?.escrowed} />
                  </strong>
                  <small>由合约托管，不能直接提取</small>
                </div>
              </div>
              <div className="stat">
                <div>
                  <span>商家累计已到账收入</span>
                  <strong>
                    <Amount value={stats.data?.income} />
                  </strong>
                </div>
              </div>
              <div className="stat">
                <div>
                  <span>会员账户数</span>
                  <strong>{stats.data?.memberships.toString() ?? '—'}</strong>
                </div>
              </div>
            </section>
          )}
          {stats.error && <QueryError error={stats.error} />}
          {merchantId === 0n && !mid.isPending && !mid.error && (
            <section className="panel">
              <h2>注册商家并创建独立金库</h2>
              <form key={`${merchantId}:${shop.data?.name ?? ''}`} onSubmit={profile}>
                <div className="form-grid">
                  <Field label="店铺名称" name="name" defaultValue={shop.data?.name} required />
                  <Field
                    label="默认收款地址"
                    name="payout"
                    defaultValue={shop.data?.defaultPayout ?? address}
                    required
                  />
                </div>
                <Field label="店铺简介" name="description" defaultValue={shop.data?.description} />
                <button className="primary" disabled={tx.busy || !configured}>
                  {merchantId ? '保存店铺资料' : '注册并创建独立金库'}
                </button>
              </form>
            </section>
          )}
          <Modal
            title="店铺资料"
            open={editor === 'profile'}
            onClose={() => setEditor(null)}
            busy={tx.busy}
          >
            <TxStatus tx={tx} />
            {vault && (
              <p className="muted wrap">
                本店独立金库：<code>{vault}</code>
              </p>
            )}
            {merchantId > 0n && (
              <p className="muted modal-description">
                店铺名称和简介会更新展示；收款地址调整仅用于之后发布的计划版本，已购会员卡条款保持原样。
              </p>
            )}
            <form key={`${merchantId}:${shop.data?.name ?? ''}`} onSubmit={profile}>
              <div className="form-grid">
                <Field label="店铺名称" name="name" defaultValue={shop.data?.name} required />
                <Field
                  label="默认收款地址"
                  name="payout"
                  defaultValue={shop.data?.defaultPayout ?? address}
                  required
                />
              </div>
              <Field label="店铺简介" name="description" defaultValue={shop.data?.description} />
              <button className="primary" disabled={tx.busy || !configured}>
                {merchantId ? '保存店铺资料' : '注册并创建独立金库'}
              </button>
            </form>
          </Modal>
          {merchantId > 0n && !!vault && (
            <>
              <Modal
                title="新建会员计划"
                open={editor === 'plan'}
                onClose={() => setEditor(null)}
                busy={tx.busy}
              >
                <TxStatus tx={tx} />
                <div className="section-heading">
                  <div className="segmented">
                    <button
                      disabled={tx.busy}
                      className={mode === 0 ? 'selected' : ''}
                      onClick={() => setMode(0)}
                    >
                      储值折扣
                    </button>
                    <button
                      disabled={tx.busy}
                      className={mode === 1 ? 'selected' : ''}
                      onClick={() => setMode(1)}
                    >
                      次数套餐
                    </button>
                  </div>
                </div>
                <form onSubmit={createPlan}>
                  <div className="form-grid">
                    <Field
                      label="计划名称"
                      name="name"
                      placeholder={mode === 0 ? '充值 500 享九折' : '10 次理发套餐'}
                      required
                    />
                    <Field label="上一版本 ID（留空为新计划）" name="previous" />
                  </div>
                  <Field label="计划说明" name="description" />
                  <div className="form-grid" key={mode}>
                    {mode === 0 ? (
                      <Field label="最低充值（USDC）" name="minimum" defaultValue="500" required />
                    ) : (
                      <label className="field">
                        <span>固定次数（次）</span>
                        <input
                          aria-label="固定次数（次）"
                          aria-describedby="fixed-units-help"
                          name="fixedUnits"
                          inputMode="numeric"
                          pattern="[1-9][0-9]*"
                          defaultValue="10"
                          required
                        />
                        <small id="fixed-units-help" className="muted">
                          每张卡包含这些次数，消费者购买时无需选择次数。
                        </small>
                      </label>
                    )}
                    {mode === 0 ? (
                      <Field label="消费实付比例（%）" name="discount" defaultValue="90" required />
                    ) : (
                      <>
                        <Field
                          label="单次原价（USDC）"
                          name="original"
                          defaultValue="88"
                          required
                        />
                        <Field label="单次优惠价（USDC）" name="sale" defaultValue="58" required />
                      </>
                    )}
                  </div>
                  <div className="form-grid">
                    <Field label="渠道收款地址（可选）" name="channel" />
                    <Field label="渠道费率（%）" name="channelFee" defaultValue="0" />
                    <Field label="邀请费率（%）" name="referralFee" defaultValue="0" />
                  </div>
                  <Notice>
                    购买时固定条款。渠道费与邀请费从实际释放金额分配，购买时不提前分账。
                  </Notice>
                  <button className="primary" disabled={tx.busy}>
                    <Plus size={16} />
                    发布会员计划
                  </button>
                </form>
              </Modal>
              <section className="panel">
                <div className="section-heading plan-list-heading">
                  <h2>会员计划列表</h2>
                  <div className="row-actions">
                    <Link className="text-link" to={`/merchant/${merchantId}`}>
                      查看店铺 <ArrowRight size={14} />
                    </Link>
                    <button
                      className="primary"
                      disabled={tx.busy}
                      onClick={() => {
                        tx.reset();
                        setMode(0);
                        setEditor('plan');
                      }}
                    >
                      <Plus size={16} /> 新建会员计划
                    </button>
                  </div>
                </div>
                {plans.isLoading ? (
                  <Loading />
                ) : plans.error ? (
                  <QueryError error={plans.error} />
                ) : !plans.data?.length ? (
                  <Empty title="还没有会员计划">点击“新建会员计划”，发布储值折扣或次数套餐。</Empty>
                ) : (
                  <>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>ID / 版本</th>
                            <th>计划</th>
                            <th>状态</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plans.data?.map((p) => (
                            <tr key={p.id.toString()}>
                              <td>
                                #{p.id.toString()} / v{p.version.toString()}
                              </td>
                              <td>
                                {p.name}
                                {p.mode === 1 && (
                                  <p className="muted">固定 {p.minUnits.toString()} 次 / 张</p>
                                )}
                              </td>
                              <td>{p.active ? '在售' : '已下架'}</td>
                              <td>
                                <button
                                  className="text-button"
                                  disabled={tx.busy}
                                  onClick={() =>
                                    void tx.run(() => tx.send('setPlanActive', [p.id, !p.active]))
                                  }
                                >
                                  {p.active ? '下架' : '重新上架'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="pagination">
                      <button
                        className="secondary"
                        disabled={!page}
                        onClick={() => setPage(page - 1)}
                      >
                        上一页
                      </button>
                      <span>第 {page + 1} 页</span>
                      <button
                        className="secondary"
                        disabled={(plans.data?.length ?? 0) < 20}
                        onClick={() => setPage(page + 1)}
                      >
                        下一页
                      </button>
                    </div>
                  </>
                )}
              </section>
              <section className="panel">
                <div className="section-heading">
                  <h2>我的会员</h2>
                  <span className="muted">每个会员账户独立展示</span>
                </div>
                {members.isPending ? (
                  <Loading />
                ) : members.error ? (
                  <QueryError error={members.error} retry={() => void members.refetch()} />
                ) : !members.data?.length ? (
                  <Empty title={memberPage ? '本页暂无会员' : '还没有会员'}>
                    消费者开通会员计划后，会在这里显示。
                  </Empty>
                ) : (
                  <div className="table-scroll member-table">
                    <table aria-label="我的会员列表">
                      <thead>
                        <tr>
                          <th>会员编号</th>
                          <th>会员昵称和 handle</th>
                          <th>已开通会员计划</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.data.map(({ id, card }) => (
                          <MerchantMemberRow
                            key={id.toString()}
                            id={id}
                            card={card}
                            vault={vault}
                            busy={billBusy}
                            onCreate={(selectedId) =>
                              setMemberSelection((previous) => ({
                                id: selectedId,
                                sequence: (previous?.sequence ?? 0) + 1,
                              }))
                            }
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {(memberPage > 0 || (members.data?.length ?? 0) >= 20) && (
                  <div className="pagination">
                    <button
                      className="secondary"
                      disabled={!memberPage || members.isFetching}
                      onClick={() => setMemberPage(memberPage - 1)}
                    >
                      上一页
                    </button>
                    <span>第 {memberPage + 1} 页</span>
                    <button
                      className="secondary"
                      disabled={members.isFetching || (members.data?.length ?? 0) < 20}
                      onClick={() => setMemberPage(memberPage + 1)}
                    >
                      下一页
                    </button>
                  </div>
                )}
              </section>
              <BillComposer
                key={`${vault}:${address}`}
                merchantId={merchantId}
                vault={vault!}
                selection={memberSelection}
                onBusyChange={setBillBusy}
              />
              <section className="panel">
                <h2>已结算消费与退出</h2>
                <History merchantId={merchantId} vault={vault} />
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}

export function PayPage() {
  const [params] = useSearchParams();
  const encoded = params.get('bill') ?? '';
  const rawVault = params.get('vault') ?? '';
  const vault = isAddress(rawVault) ? getAddress(rawVault) : undefined;
  const { address, chainId } = useAccount();
  const tx = useTransactions(vault);
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(false), [encoded, vault]);
  let envelope: Envelope | undefined,
    decodeError = '';
  try {
    if (!configured || !manifest.factory) throw new Error('当前环境尚未部署工厂合约');
    if (!vault) throw new Error('账单缺少有效的商家金库地址');
    envelope = decodeEnvelope(encoded, manifest.chainId, vault);
  } catch (e) {
    decodeError = errorText(e);
  }
  const validation = useQuery({
    queryKey: [...queryScope, vault, 'bill', encoded],
    enabled: !!envelope && !settled,
    refetchInterval: 5000,
    queryFn: async () => {
      const e = envelope!;
      await registeredVault(vault!);
      const valid = await publicClient.verifyTypedData({
        address: e.bill.merchantSigner,
        domain: billDomain(manifest.chainId, vault!),
        types: BILL_TYPES,
        primaryType: 'Bill',
        message: e.bill,
        signature: e.merchantSignature,
      });
      if (!valid) throw new Error('商家签名无效或已撤销');
      return readVault<Preview>(vault!, 'previewSettlement', [e.bill]);
    },
  });
  const owner = envelope?.bill.consumer.toLowerCase() === address?.toLowerCase();
  return (
    <>
      <Title title="确认本次消费" description="核对服务与扣款明细，签名并提交后才会完成支付。" />
      {decodeError ? (
        <Notice tone="danger">{decodeError}</Notice>
      ) : (
        envelope && (
          <div className="two-column">
            <section className="panel">
              <span className="tag">会员账户 #{envelope.bill.membershipId.toString()}</span>
              <h2>{envelope.serviceText}</h2>
              <div className="detail-line">
                <span>消费者</span>
                <UserLabel account={envelope.bill.consumer} />
              </div>
              <div className="detail-line">
                <span>消费原价</span>
                <Amount value={envelope.bill.originalValue} />
              </div>
              {envelope.bill.mode === 0 ? (
                <div className="detail-line">
                  <span>消费实付比例</span>
                  <strong>{Number(envelope.bill.discountBps) / 100}%</strong>
                </div>
              ) : (
                <div className="detail-line">
                  <span>本次使用</span>
                  <strong>{envelope.bill.units.toString()} 次</strong>
                </div>
              )}
              <div className="refund-total">
                <span>本次本金扣除</span>
                <strong>
                  <Amount value={envelope.bill.debitAmount} />
                </strong>
              </div>
              {settled ? (
                <Notice tone="success">本次消费已完成链上结算，账单不能重复执行。</Notice>
              ) : validation.isLoading ? (
                <Loading />
              ) : validation.error ? (
                <QueryError error={validation.error} />
              ) : (
                validation.data && (
                  <>
                    <div className="detail-line">
                      <span>消费后余额</span>
                      <Amount value={validation.data.remainingPrincipal} />
                    </div>
                    <div className="detail-line">
                      <span>消费后预计可退金额</span>
                      <Amount value={validation.data.refundableAfter} />
                    </div>
                  </>
                )
              )}
              {!owner && <Notice>请连接账单指定的消费者钱包：{envelope.bill.consumer}</Notice>}
              <button
                className="primary wide"
                disabled={
                  settled ||
                  !owner ||
                  chainId !== manifest.chainId ||
                  !validation.data ||
                  !!validation.error ||
                  tx.busy
                }
                onClick={() => {
                  const current = envelope!;
                  void tx.run(async () => {
                    await readVault<Preview>(vault!, 'previewSettlement', [current.bill]);
                    const consumerSignature = await tx.sign(current.bill);
                    await tx.send('settle', [
                      current.bill,
                      current.merchantSignature,
                      consumerSignature,
                    ]);
                    setSettled(true);
                  });
                }}
              >
                {settled ? '本次消费已结算' : tx.busy ? '结算处理中…' : '确认消费，签名并支付'}
              </button>
              <TxStatus tx={tx} />
            </section>
            <aside className="panel rules">
              <ShieldCheck size={26} />
              <h3>双方确认，同笔结算</h3>
              <p>
                商家已经签署这份账单。你签署相同内容并发送交易后，合约会验证双方签名，同时扣除权益并完成分账。
              </p>
              <p>
                签名截止：{new Date(Number(envelope.bill.deadline) * 1000).toLocaleString('zh-CN')}
              </p>
              <p>提交交易需要测试 MON。钱包签名和链上交易确认是两个步骤。</p>
            </aside>
          </div>
        )
      )}
    </>
  );
}

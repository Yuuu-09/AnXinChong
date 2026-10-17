import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowUpRight, CircleAlert, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { formatAmount } from '@anxinchong/protocol/math';
import {
  configured,
  manifest,
  historyClient,
  queryScope,
  readVault,
  readFactory,
  allMerchants,
  registeredVault,
  mapConcurrent,
} from './lib/runtime';
import { scanHistory } from './lib/event-cache';
import { errorText, type useTransactions } from './lib/transactions';
import { getAddress, isAddress, type Address } from 'viem';

export const money = (value: bigint | undefined) =>
  value === undefined ? '—' : formatAmount(value);
export function useVault() {
  const value = useParams().vault;
  if (!value || !isAddress(value))
    throw new Error('缺少有效的商家金库地址，请重新从商家或会员卡列表进入');
  return getAddress(value);
}
export function useFactoryRead<T>(name: string, args: readonly unknown[] = [], enabled = true) {
  return useQuery({
    queryKey: [...queryScope, 'factory', name, args],
    queryFn: () => readFactory<T>(name, args),
    enabled: configured && enabled,
  });
}
export function useRead<T>(
  name: string,
  args: readonly unknown[] = [],
  enabled = true,
  vault?: Address,
) {
  return useQuery({
    queryKey: [...queryScope, vault, name, args],
    queryFn: () => readVault<T>(vault!, name, args),
    enabled: configured && enabled && !!vault,
    staleTime: name === 'getPlanVersion' ? 30_000 : 5000,
  });
}
export function Amount({ value, symbol = true }: { value: bigint | undefined; symbol?: boolean }) {
  return (
    <span className="amount">
      {money(value)}
      {symbol && <small> {manifest.assetSymbol}</small>}
    </span>
  );
}
export function Notice({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'danger' | 'success';
}) {
  return (
    <div className={`notice ${tone}`}>
      <CircleAlert size={16} />
      <div>{children}</div>
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <ShieldCheck size={32} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle size={20} className="spin" />
      正在读取链上数据…
    </div>
  );
}
export function QueryError({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <Notice tone="danger">
      {errorText(error)}{' '}
      {retry && (
        <button className="text-button" onClick={retry}>
          重试
        </button>
      )}
    </Notice>
  );
}
export function TxStatus({ tx }: { tx: ReturnType<typeof useTransactions> }) {
  return (
    <div aria-live="polite">
      {tx.phase && (
        <Notice tone={tx.busy ? 'info' : 'success'}>
          {tx.busy && <LoaderCircle size={14} className="spin" />} {tx.phase}
          {tx.hash && (
            <Link to={`/tx/${tx.hash}`}>
              查看交易 <ArrowUpRight size={13} />
            </Link>
          )}
        </Notice>
      )}
      {tx.error && <Notice tone="danger">{tx.error}</Notice>}
    </div>
  );
}
export function Title({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function Modal({
  title,
  open,
  onClose,
  busy = false,
  className = '',
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      element.close();
      document.body.style.overflow = overflow;
    };
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`modal ${className}`.trim()}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      {open && (
        <div className="modal-content">
          <div className="modal-heading">
            <h2 id={titleId}>{title}</h2>
            <button
              type="button"
              className="modal-close"
              aria-label="关闭弹窗"
              disabled={busy}
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
export function Field({
  label,
  name,
  defaultValue,
  placeholder,
  type = 'text',
  required = false,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        type={type}
        required={required}
      />
    </label>
  );
}
export function History({
  membershipId,
  merchantId,
  recipient,
  vault,
}: {
  membershipId?: bigint;
  merchantId?: bigint;
  recipient?: Address;
  vault?: Address;
}) {
  const field = recipient ? 'recipient' : merchantId ? 'merchantId' : 'membershipId';
  const value = recipient ?? merchantId ?? membershipId!;
  const query = useQuery({
    queryKey: [...queryScope, vault, 'history', field, value],
    enabled: configured && value !== undefined,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const shops = vault ? [{ shop: await registeredVault(vault) }] : await allMerchants();
      const batches = await mapConcurrent(
        shops,
        async ({ shop }) => {
          const batch = await scanHistory(
            historyClient,
            {
              chainId: manifest.chainId,
              factory: manifest.factory!,
              address: shop.vault,
              deploymentBlock: shop.deploymentBlock,
              field,
              value,
            },
            signal,
          );
          return batch.map((log) => ({ ...log, vault: shop.vault }));
        },
        2,
      );
      const logs = batches.flat();
      return logs.sort((a, b) =>
        a.blockNumber < b.blockNumber
          ? -1
          : a.blockNumber > b.blockNumber
            ? 1
            : a.logIndex - b.logIndex,
      );
    },
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  if (!query.data?.length) return <div className="subtle-empty">暂无已结算记录</div>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>类型</th>
            <th>账户</th>
            <th>金额</th>
            <th>链上凭证</th>
          </tr>
        </thead>
        <tbody>
          {[...query.data].reverse().map((log) => (
            <tr key={`${log.vault}:${log.transactionHash}:${log.logIndex}`}>
              <td>
                {log.eventName === 'ConsumptionSettled'
                  ? '消费结算'
                  : log.eventName === 'MembershipExited'
                    ? '退出退款'
                    : `收入 · ${['商家', '渠道', '邀请'][Number(log.args.role)] ?? '分账'}`}
              </td>
              <td>
                <Link to={`/cards/${log.vault}/${String(log.args.membershipId)}`}>
                  #{String(log.args.membershipId)}
                </Link>
                <small className="muted"> · {log.vault.slice(0, 8)}…</small>
              </td>
              <td>
                <Amount
                  value={(log.args.debitAmount ?? log.args.refund ?? log.args.amount) as bigint}
                />
              </td>
              <td>
                <Link className="text-link" to={`/tx/${log.transactionHash}`}>
                  查看交易 <ArrowUpRight size={13} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

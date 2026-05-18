import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode
} from 'react';
import { cn } from '../../lib/cn';

type ButtonVariant = 'primary' | 'secondary';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: false;
  children: ReactNode;
  variant?: ButtonVariant;
};

type AnchorButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  asChild: true;
  children: ReactNode;
  variant?: ButtonVariant;
};

export function Button(props: ButtonProps | AnchorButtonProps) {
  const { className, variant = 'primary', ...rest } = props;
  const classes = cn(
    'inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors',
    variant === 'primary'
      ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
      : 'border-border bg-muted text-foreground hover:bg-muted/80',
    className
  );

  if (props.asChild) {
    const { asChild: _asChild, ...anchorProps } = rest as AnchorButtonProps;
    return <a className={classes} {...anchorProps} />;
  }

  const { asChild: _asChild, ...buttonProps } = rest as ButtonProps;
  return <button className={classes} {...buttonProps} />;
}

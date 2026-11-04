import { useEffect, useState } from 'preact/hooks';
import ConfirmDialog from '@/components/ConfirmDialog';
import PasswordGenerator from '@/components/PasswordGenerator';
import { t } from '@/lib/i18n';
import type { GeneratorMode } from '@/lib/password-generator';

const MODAL_MODES: GeneratorMode[] = ['password', 'passphrase', 'pin'];

interface PasswordGeneratorModalProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

export default function PasswordGeneratorModal(props: PasswordGeneratorModalProps) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!props.open) setValue('');
  }, [props.open]);

  return (
    <ConfirmDialog
      open={props.open}
      title={t('txt_password_generator')}
      message={t('txt_password_generator_description')}
      confirmText={t('txt_confirm')}
      cancelText={t('txt_cancel')}
      confirmDisabled={!value}
      cardClassName="generator-modal-card"
      onConfirm={() => {
        if (value) props.onConfirm(value);
      }}
      onCancel={props.onCancel}
    >
      <PasswordGenerator modes={MODAL_MODES} onValueChange={setValue} />
    </ConfirmDialog>
  );
}

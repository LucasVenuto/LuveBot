// dashboard/src/components/rooms/CostConfirmModal.tsx
// Modal for confirming cost before sending @todos or multi-member messages (Contract v0.3 §3.3).

import React from "react";
import { useLuveI18n } from "../../i18n";
import { Dialog } from "../ui/Dialog";

export interface CostConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isSubmitting?: boolean;
}

export function CostConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  isSubmitting = false,
}: CostConfirmModalProps) {
  const { t } = useLuveI18n();

  return (
    <Dialog open={isOpen} onClose={onClose} title={t("modalCostConfirmTitle")} titleId="cost-confirm-title" width={420}>
      <div className="lb-dialog-body">
        <p className="lb-body" style={{ margin: 0 }}>{t("modalCostConfirmBody")}</p>
        <div className="lb-dialog-footer">
          <button type="button" onClick={onClose} className="lb-btn">{t("cancelBtn")}</button>
          <button type="button" onClick={onConfirm} disabled={isSubmitting} className="lb-btn lb-btn-primary">
            {isSubmitting ? t("saving") : t("btnConfirmCostSend")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

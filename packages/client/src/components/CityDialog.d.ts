import { UnitType } from '@sc/shared';
interface Props {
    cityId: string;
    currentProduction: UnitType | null;
    turnsLeft: number;
    coastal: boolean;
    onClose: () => void;
}
export declare function CityDialog({ cityId, currentProduction, turnsLeft, coastal, onClose }: Props): import("react").JSX.Element;
export {};
//# sourceMappingURL=CityDialog.d.ts.map
<?php

namespace App\Model;

use Doctrine\ORM\Mapping as ORM;

// Sem MappedSuperclass: o Doctrine não mapeia estas propriedades nas filhas.
abstract class PlainBase extends BaseEntity
{
    #[ORM\Column]
    protected string $ignored = '';
}
